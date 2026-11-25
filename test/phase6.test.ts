/**
 * Phase 6 verification — Core API Endpoints.
 *
 *   npm test        # runs everything under test/
 *
 * Coverage matches roadmap Phase 6 "Verify": exercise each endpoint with a dev identity
 * against a fake D1 and a mocked Sendmode, and assert status codes, D1 rows created, and that
 * enqueue counts are correct.
 *
 * The doubles live in `test/helpers/fakes.ts`: `FakeD1` (narrow in-memory D1), `FakeQueue`
 * (records messages + `sendBatch` slicing), and `stubProvider` (global `fetch` for Sendmode).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp, type Env } from "../src/index.js";
import { FakeD1, FakeQueue, stubProvider } from "./helpers/fakes.js";

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/** A dev-authenticated request env backed by the given fakes. */
function makeEnv(db: FakeD1, queue: FakeQueue): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: queue as unknown as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
    DEV_AUTH_BYPASS: "true",
  };
}

/** Two audience chunks: 3 + 2 = 5 clean recipients. */
function seededDb(): FakeD1 {
  const db = new FakeD1();
  db.seedAudience([
    ["+447700900001", "+447700900002", "+447700900003"],
    ["+447700900004", "+447700900005"],
  ]);
  return db;
}

/** Standard authenticated JSON request init. */
function json(init: { method?: string; body?: unknown } = {}): RequestInit {
  return {
    method: init.method ?? "POST",
    headers: { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  };
}

// =======================================================================================
// 6.1 — GET /api/balance
// =======================================================================================

test("6.1 GET /api/balance returns provider balance + audience count (opt-outs subtracted)", async () => {
  const db = seededDb();
  db.optOuts.push({ mobile_number: "+447700900005", created_at: "2026-01-01T00:00:00Z" });
  const queue = new FakeQueue();
  const provider = stubProvider(5000);

  try {
    const app = createApp();
    const res = await app.request("/api/balance", {}, makeEnv(db, queue));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { balance: 5000, audience_count: 4 }); // 5 − 1 opt-out
    assert.equal(provider.calls[0]?.url, "https://sms-rest.sendmode.dev/3.0/balance");
  } finally {
    provider.restore();
  }
});

test("6.1 GET /api/balance surfaces a provider failure as 502", async () => {
  const provider = stubProvider();
  provider.failStatus = 503;
  try {
    const app = createApp();
    const res = await app.request("/api/balance", {}, makeEnv(seededDb(), new FakeQueue()));
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.equal(body.error, "provider_error");
    assert.equal(body.reason, "server_error");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 6.2 — POST /api/campaigns
// =======================================================================================

test("6.2 POST /api/campaigns validates, writes campaign + batches, and enqueues one message per batch", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({ body: { name: "Spring Promo", senderId: "DHSC", message: "Hello!", mode: "IMMEDIATE" } }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 202);
    const body = (await res.json()) as { id: string; totalBatches: number; estimatedCredits: number };
    assert.equal(body.totalBatches, 2);
    assert.equal(body.estimatedCredits, 5); // 1 segment × 5 recipients

    // D1 rows created: one campaign (QUEUED) and two batches (PENDING).
    assert.equal(db.campaigns.length, 1);
    assert.equal(db.campaigns[0]?.status, "QUEUED");
    assert.equal(db.campaigns[0]?.total_recipients, 5);
    assert.equal(db.campaigns[0]?.is_test, 0);
    assert.equal(db.batches.length, 2);
    assert.deepEqual(
      db.batches.map((b) => b.status),
      ["PENDING", "PENDING"],
    );

    // Enqueue: one DISPATCH_BATCH per batch, and each sendBatch carried ≤100.
    assert.equal(queue.messages.length, 2);
    assert.deepEqual(
      queue.messages.map((m) => m.type),
      ["DISPATCH_BATCH", "DISPATCH_BATCH"],
    );
    assert.deepEqual(queue.batches, [2]);
    // Each message carries its stripped chunk recipients so the consumer never re-reads the raw
    // `audience_chunks` row (the Phase 9 fix): batch 0 → chunk 0's 3 numbers, batch 1 → chunk 1's 2.
    assert.deepEqual(
      queue.messages.map((m) => (m.type === "DISPATCH_BATCH" ? m.recipients : null)),
      [
        ["+447700900001", "+447700900002", "+447700900003"],
        ["+447700900004", "+447700900005"],
      ],
    );
  } finally {
    provider.restore();
  }
});

test("6.2 POST /api/campaigns strips opt-outs from the audience before sending", async () => {
  const db = seededDb();
  db.optOuts.push({ mobile_number: "+447700900001", created_at: "2026-01-01T00:00:00Z" });
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({ body: { name: "Promo", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" } }),
      makeEnv(db, queue),
    );
    assert.equal(res.status, 202);
    const body = (await res.json()) as { totalRecipients: number };
    assert.equal(body.totalRecipients, 4); // 5 − 1 opt-out
    // The opted-out number must be gone from **every** queued payload (not just the count).
    const queuedNumbers = queue.messages.flatMap((m) =>
      m.type === "DISPATCH_BATCH" ? (m.recipients ?? []) : [],
    );
    assert.equal(queuedNumbers.length, 4);
    assert.ok(!queuedNumbers.includes("+447700900001"), "opted-out number is stripped from the enqueued recipients");
  } finally {
    provider.restore();
  }
});

test("6.2 POST /api/campaigns rejects invalid input with 400 + field issues", async () => {
  const provider = stubProvider();
  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({ body: { name: "", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" } }),
      makeEnv(seededDb(), new FakeQueue()),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; issues: Array<{ field: string }> };
    assert.equal(body.error, "validation_failed");
    assert.equal(body.issues[0]?.field, "name");
  } finally {
    provider.restore();
  }
});

test("6.2 POST /api/campaigns blocks a send the balance cannot cover (400, nothing written)", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(2); // only 2 credits, campaign needs 5

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({ body: { name: "Promo", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" } }),
      makeEnv(db, queue),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; required: number; available: number };
    assert.equal(body.error, "insufficient_balance");
    assert.equal(body.required, 5);
    assert.equal(body.available, 2);
    assert.equal(db.campaigns.length, 0); // nothing persisted
    assert.equal(queue.messages.length, 0); // nothing queued
  } finally {
    provider.restore();
  }
});

test("6.2 POST /api/campaigns enqueues in slices of ≤100 (81 batches → 1×81, 101 batches → 100+1)", async () => {
  // 101 single-recipient chunks.
  const db = new FakeD1();
  db.seedAudience(Array.from({ length: 101 }, (_, i) => [`+4477009${String(i).padStart(5, "0")}`]));
  const queue = new FakeQueue();
  const provider = stubProvider(100_000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({ body: { name: "Big", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" } }),
      makeEnv(db, queue),
    );
    assert.equal(res.status, 202);
    assert.equal(queue.messages.length, 101);
    assert.deepEqual(queue.batches, [100, 1]); // two sendBatch() calls
  } finally {
    provider.restore();
  }
});

test("6.2 POST /api/campaigns schedules with a UTC date computed from UK local time", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    // Pick a UK local time comfortably in the future relative to the test's "now". We use a
    // far-future slot so the ≥20-minute lead rule is trivially satisfied.
    const res = await app.request(
      "/api/campaigns",
      json({
        body: {
          name: "Later",
          senderId: "DHSC",
          message: "Hi",
          mode: "SCHEDULED",
          scheduleLocal: "2027-07-15T14:00", // BST → 13:00Z
        },
      }),
      makeEnv(db, queue),
    );
    assert.equal(res.status, 202);
    assert.equal(db.campaigns[0]?.mode, "SCHEDULED");
    assert.equal(db.campaigns[0]?.schedule_date, "2027-07-15T13:00:00Z");
  } finally {
    provider.restore();
  }
});

// ---------------------------------------------------------------------------------------
// 13.2 — create idempotency (Idempotency-Key)
// ---------------------------------------------------------------------------------------

test("13.2 POST /api/campaigns replays the stored result for a repeated Idempotency-Key", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const init = json({
      body: { name: "Retry-safe", senderId: "DHSC", message: "Hello!", mode: "IMMEDIATE" },
    });
    const withKey: RequestInit = {
      ...init,
      headers: { "Content-Type": "application/json", "Idempotency-Key": "key-abc-123" },
    };

    const first = await app.request("/api/campaigns", withKey, makeEnv(db, queue));
    assert.equal(first.status, 202);
    const firstBody = await first.text();

    // A byte-identical retry of the same submission: same key, same body.
    const second = await app.request("/api/campaigns", withKey, makeEnv(db, queue));
    assert.equal(second.status, 202);
    assert.equal(await second.text(), firstBody);

    // Exactly one campaign, one set of batches, and one enqueue happened across both calls.
    assert.equal(db.campaigns.length, 1);
    assert.equal(db.batches.length, 2);
    assert.equal(queue.messages.length, 2);

    // The key was persisted once, pointing at the single campaign we created.
    assert.equal(db.idempotencyKeys.length, 1);
    assert.equal(db.idempotencyKeys[0]?.key, "key-abc-123");
    assert.equal(db.idempotencyKeys[0]?.campaign_id, db.campaigns[0]?.id);
    assert.equal(db.idempotencyKeys[0]?.response_json, firstBody);

    // A *different* key is a genuinely new submission and creates a second campaign.
    const other = await app.request(
      "/api/campaigns",
      { ...init, headers: { "Content-Type": "application/json", "Idempotency-Key": "key-def-456" } },
      makeEnv(db, queue),
    );
    assert.equal(other.status, 202);
    assert.equal(db.campaigns.length, 2);
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 6.3 — GET /api/campaigns
// =======================================================================================

test("12.2 manual list: mixed spellings normalize, dedupe, and enqueue as exactly the E.164 numbers", async () => {
  const db = seededDb(); // audience is irrelevant for a manual send
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({
        body: {
          name: "Regulars",
          senderId: "DHSC",
          message: "Hi",
          mode: "IMMEDIATE",
          // +447…, bare 447…, 07… with spaces, a duplicate, and a dashed form.
          recipients: "+447700900077\n447700900078\n07 700 900 079, 0770-0900-080\n+447700900077",
        },
      }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 202);
    const body = (await res.json()) as { totalRecipients: number; totalBatches: number };
    assert.equal(body.totalRecipients, 4); // duplicate collapsed
    assert.equal(body.totalBatches, 1); // all fit one ≤100 chunk

    // D1 rows: one campaign + one batch, from the pasted numbers (no audience_chunks read).
    assert.equal(db.campaigns.length, 1);
    assert.equal(db.campaigns[0]?.total_recipients, 4);
    assert.equal(db.batches.length, 1);

    // The one DISPATCH_BATCH carries exactly the normalised numbers, in order.
    assert.equal(queue.messages.length, 1);
    const message = queue.messages[0];
    assert.equal(message?.type, "DISPATCH_BATCH");
    assert.deepEqual(
      message?.type === "DISPATCH_BATCH" ? message.recipients : null,
      ["+447700900077", "+447700900078", "+447700900079", "+447700900080"],
    );
    // One sendBatch() call, carrying a single message (chunks are ≤100 per message).
    assert.deepEqual(queue.batches, [1]);
  } finally {
    provider.restore();
  }
});

test("12.2 manual list: chunks the survivors into ≤100-recipient batches", async () => {
  const db = new FakeD1();
  const queue = new FakeQueue();
  const provider = stubProvider(100_000);

  try {
    const app = createApp();
    // 101 distinct valid numbers → batch 0 has 100, batch 1 has 1.
    const list = Array.from({ length: 101 }, (_, i) => `+447700900${String(i).padStart(3, "0")}`).join("\n");
    const res = await app.request(
      "/api/campaigns",
      json({ body: { name: "Big manual", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE", recipients: list } }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 202);
    const body = (await res.json()) as { totalRecipients: number; totalBatches: number };
    assert.equal(body.totalRecipients, 101);
    assert.equal(body.totalBatches, 2);

    // No batch message carries more than 100 recipients.
    const sizes = queue.messages.map((m) => (m.type === "DISPATCH_BATCH" ? (m.recipients ?? []).length : 0));
    assert.deepEqual(sizes, [100, 1]);
  } finally {
    provider.restore();
  }
});

test("12.2 manual list: strips opted-out numbers from the enqueued payload", async () => {
  const db = seededDb();
  db.optOuts.push({ mobile_number: "+447700900078", created_at: "2026-01-01T00:00:00Z" });
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({
        body: {
          name: "Regulars",
          senderId: "DHSC",
          message: "Hi",
          mode: "IMMEDIATE",
          recipients: "+447700900077, +447700900078, +447700900079",
        },
      }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 202);
    const body = (await res.json()) as { totalRecipients: number };
    assert.equal(body.totalRecipients, 2); // the opt-out is gone

    const queuedNumbers = queue.messages.flatMap((m) =>
      m.type === "DISPATCH_BATCH" ? (m.recipients ?? []) : [],
    );
    assert.deepEqual(queuedNumbers, ["+447700900077", "+447700900079"]);
    assert.ok(!queuedNumbers.includes("+447700900078"), "opted-out number is absent from the queue payload");
  } finally {
    provider.restore();
  }
});

test("12.2 manual list: one bad entry refuses the whole request (400), nothing written, nothing enqueued", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({
        body: {
          name: "Regulars",
          senderId: "DHSC",
          message: "Hi",
          mode: "IMMEDIATE",
          recipients: "+447700900077\n+441234\nhello",
        },
      }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; issues: Array<{ field: string; code: string }> };
    assert.equal(body.error, "validation_failed");
    // One issue per bad entry, all on the `recipients` field.
    assert.equal(body.issues.length, 2);
    assert.ok(body.issues.every((i) => i.field === "recipients" && i.code === "invalid_number"));

    assert.equal(db.campaigns.length, 0); // no campaigns row
    assert.equal(db.batches.length, 0); // no campaign_batches row
    assert.equal(queue.messages.length, 0); // nothing enqueued at all
  } finally {
    provider.restore();
  }
});

test("12.2 manual list: every number opted out → 400 empty_audience", async () => {
  const db = seededDb();
  db.optOuts.push(
    { mobile_number: "+447700900077", created_at: "2026-01-01T00:00:00Z" },
    { mobile_number: "+447700900078", created_at: "2026-01-01T00:00:00Z" },
  );
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({
        body: {
          name: "Regulars",
          senderId: "DHSC",
          message: "Hi",
          mode: "IMMEDIATE",
          recipients: "+447700900077, 07700900078",
        },
      }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "empty_audience");
    assert.equal(db.campaigns.length, 0);
    assert.equal(queue.messages.length, 0);
  } finally {
    provider.restore();
  }
});

test("12.2 manual list: insufficient_balance refuses a manual send just like a default one", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(2); // only 2 credits; the manual list needs 3

  try {
    const app = createApp();
    const res = await app.request(
      "/api/campaigns",
      json({
        body: {
          name: "Regulars",
          senderId: "DHSC",
          message: "Hi",
          mode: "IMMEDIATE",
          recipients: "+447700900077, +447700900078, +447700900079",
        },
      }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; required: number; available: number };
    assert.equal(body.error, "insufficient_balance");
    assert.equal(body.required, 3);
    assert.equal(body.available, 2);
    assert.equal(db.campaigns.length, 0); // nothing persisted
    assert.equal(queue.messages.length, 0); // nothing queued
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 6.3 — GET /api/campaigns
// =======================================================================================

test("6.3 GET /api/campaigns filters upcoming vs history and orders by created_at DESC", async () => {
  const db = seededDb();
  db.campaigns.push(
    // history: a sent immediate campaign
    {
      id: "c-old", name: "Old", sender_id: "DHSC", message: "m", mode: "IMMEDIATE",
      schedule_date: null, status: "SENT", total_recipients: 5, total_batches: 1,
      completed_batches: 1, failed_batches: 0, invalid_count: 0, estimated_credits: 5,
      is_test: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    },
    // history: newer
    {
      id: "c-new", name: "New", sender_id: "DHSC", message: "m", mode: "IMMEDIATE",
      schedule_date: null, status: "QUEUED", total_recipients: 5, total_batches: 1,
      completed_batches: 0, failed_batches: 0, invalid_count: 0, estimated_credits: 5,
      is_test: 0, created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
    },
    // upcoming: scheduled
    {
      id: "c-future", name: "Future", sender_id: "DHSC", message: "m", mode: "SCHEDULED",
      schedule_date: "2027-01-01T10:00:00Z", status: "SCHEDULED", total_recipients: 5,
      total_batches: 1, completed_batches: 0, failed_batches: 0, invalid_count: 0,
      estimated_credits: 5, is_test: 0, created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    },
  );
  const provider = stubProvider();
  try {
    const app = createApp();

    const history = await app.request("/api/campaigns?filter=history", {}, makeEnv(db, new FakeQueue()));
    assert.equal(history.status, 200);
    const historyBody = (await history.json()) as { campaigns: Array<{ id: string }> };
    assert.deepEqual(historyBody.campaigns.map((c) => c.id), ["c-new", "c-old"]); // DESC

    const upcoming = await app.request("/api/campaigns?filter=upcoming", {}, makeEnv(db, new FakeQueue()));
    const upcomingBody = (await upcoming.json()) as { campaigns: Array<{ id: string }> };
    assert.deepEqual(upcomingBody.campaigns.map((c) => c.id), ["c-future"]);

    // Default (no filter) = history.
    const defaulted = await app.request("/api/campaigns", {}, makeEnv(db, new FakeQueue()));
    const defaultedBody = (await defaulted.json()) as { filter: string };
    assert.equal(defaultedBody.filter, "history");

    // Unknown filter → 400.
    const bad = await app.request("/api/campaigns?filter=nope", {}, makeEnv(db, new FakeQueue()));
    assert.equal(bad.status, 400);
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 6.4 — GET /api/campaigns/:id
// =======================================================================================

test("6.4 GET /api/campaigns/:id returns progress + per-batch errors; 404 when missing", async () => {
  const db = seededDb();
  db.campaigns.push({
    id: "c1", name: "Promo", sender_id: "DHSC", message: "m", mode: "IMMEDIATE",
    schedule_date: null, status: "PARTIAL_FAILURE", total_recipients: 5, total_batches: 2,
    completed_batches: 1, failed_batches: 1, invalid_count: 2, estimated_credits: 5,
    is_test: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  });
  db.batches.push(
    {
      id: "b1", campaign_id: "c1", chunk_index: 0, status: "SENT",
      sendmode_request_id: "req-1", invalid_numbers_json: '["+447700900009"]',
      error_message: null, updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "b2", campaign_id: "c1", chunk_index: 1, status: "FAILED",
      sendmode_request_id: null, invalid_numbers_json: null,
      error_message: "Sendmode responded with HTTP 400", updated_at: "2026-01-01T00:00:00Z",
    },
  );
  const provider = stubProvider();
  try {
    const app = createApp();
    const res = await app.request("/api/campaigns/c1", {}, makeEnv(db, new FakeQueue()));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      campaign: { id: string; invalidCount: number; completedBatches: number };
      batches: Array<{ id: string; status: string; invalidNumbers: string[]; error: string | null }>;
    };
    assert.equal(body.campaign.id, "c1");
    assert.equal(body.campaign.invalidCount, 2);
    assert.equal(body.campaign.completedBatches, 1);
    assert.equal(body.batches.length, 2);
    assert.deepEqual(body.batches[0]?.invalidNumbers, ["+447700900009"]);
    assert.equal(body.batches[1]?.error, "Sendmode responded with HTTP 400");

    const missing = await app.request("/api/campaigns/nope", {}, makeEnv(db, new FakeQueue()));
    assert.equal(missing.status, 404);
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 6.5 — POST /api/campaigns/:id/cancel
// =======================================================================================

test("6.5 cancel marks CANCELLING, retires PENDING batches, and enqueues CANCEL_BATCH per scheduled batch", async () => {
  const db = seededDb();
  db.campaigns.push({
    id: "c1", name: "Future", sender_id: "DHSC", message: "m", mode: "SCHEDULED",
    schedule_date: "2027-01-01T10:00:00Z", status: "SCHEDULED", total_recipients: 5,
    total_batches: 2, completed_batches: 1, failed_batches: 0, invalid_count: 0,
    estimated_credits: 5, is_test: 0, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  db.batches.push(
    {
      id: "b1", campaign_id: "c1", chunk_index: 0, status: "SCHEDULED",
      sendmode_request_id: "req-1", invalid_numbers_json: null, error_message: null,
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "b2", campaign_id: "c1", chunk_index: 1, status: "PENDING",
      sendmode_request_id: null, invalid_numbers_json: null, error_message: null,
      updated_at: "2026-01-01T00:00:00Z",
    },
  );
  const queue = new FakeQueue();
  const provider = stubProvider();

  try {
    const app = createApp();
    const res = await app.request("/api/campaigns/c1/cancel", json(), makeEnv(db, queue));
    assert.equal(res.status, 202);
    const body = (await res.json()) as { status: string; enqueued: number };
    assert.equal(body.status, "CANCELLING");
    assert.equal(body.enqueued, 1); // only b1 had a request_id

    assert.equal(db.campaigns[0]?.status, "CANCELLING");
    assert.equal(db.batches.find((b) => b.id === "b2")?.status, "CANCELLED"); // PENDING retired
    assert.equal(queue.messages.length, 1);
    assert.equal(queue.messages[0]?.type, "CANCEL_BATCH");
  } finally {
    provider.restore();
  }
});

test("6.5 cancel of an already-terminal campaign is rejected (409); unknown id → 404", async () => {
  const db = seededDb();
  db.campaigns.push({
    id: "c1", name: "Done", sender_id: "DHSC", message: "m", mode: "IMMEDIATE",
    schedule_date: null, status: "SENT", total_recipients: 5, total_batches: 1,
    completed_batches: 1, failed_batches: 0, invalid_count: 0, estimated_credits: 5,
    is_test: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  });
  const provider = stubProvider();
  try {
    const app = createApp();
    const conflict = await app.request("/api/campaigns/c1/cancel", json(), makeEnv(db, new FakeQueue()));
    assert.equal(conflict.status, 409);

    const missing = await app.request("/api/campaigns/nope/cancel", json(), makeEnv(db, new FakeQueue()));
    assert.equal(missing.status, 404);
  } finally {
    provider.restore();
  }
});

test("6.5 cancelling a QUEUED campaign with no provider jobs marks it CANCELLED immediately", async () => {
  const db = seededDb();
  db.campaigns.push({
    id: "c1", name: "Immediate", sender_id: "DHSC", message: "m", mode: "IMMEDIATE",
    schedule_date: null, status: "QUEUED", total_recipients: 5, total_batches: 1,
    completed_batches: 0, failed_batches: 0, invalid_count: 0, estimated_credits: 5,
    is_test: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  });
  db.batches.push({
    id: "b1", campaign_id: "c1", chunk_index: 0, status: "PENDING",
    sendmode_request_id: null, invalid_numbers_json: null, error_message: null,
    updated_at: "2026-01-01T00:00:00Z",
  });
  const queue = new FakeQueue();
  const provider = stubProvider();
  try {
    const app = createApp();
    const res = await app.request("/api/campaigns/c1/cancel", json(), makeEnv(db, queue));
    assert.equal(res.status, 202);
    assert.equal(db.campaigns[0]?.status, "CANCELLED");
    assert.equal(queue.messages.length, 0);
  } finally {
    provider.restore();
  }
});

// Roadmap 13.4.1/13.4.2: a SCHEDULED campaign whose `schedule_date` has already passed is refused
// with 409 and left untouched — the provider may already have sent it, so a local CANCELLED would
// be a lie. A still-future scheduled campaign cancels exactly as before.
test("13.4 a past-due scheduled cancel is refused (409) and the status is left unchanged", async () => {
  const db = seededDb();
  db.campaigns.push({
    id: "c1", name: "Overdue", sender_id: "DHSC", message: "m", mode: "SCHEDULED",
    schedule_date: "2020-01-01T10:00:00Z", status: "SCHEDULED", total_recipients: 5,
    total_batches: 1, completed_batches: 1, failed_batches: 0, invalid_count: 0,
    estimated_credits: 5, is_test: 0, created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
  });
  db.batches.push({
    id: "b1", campaign_id: "c1", chunk_index: 0, status: "SCHEDULED",
    sendmode_request_id: "req-1", invalid_numbers_json: null, error_message: null,
    updated_at: "2020-01-01T00:00:00Z",
  });
  const queue = new FakeQueue();
  const provider = stubProvider();
  try {
    const app = createApp();
    const res = await app.request("/api/campaigns/c1/cancel", json(), makeEnv(db, queue));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "conflict");
    assert.match(body.message, /scheduled time has passed/);

    // Nothing was flipped or enqueued: still SCHEDULED, no CANCEL_BATCH, no false CANCELLED.
    assert.equal(db.campaigns[0]?.status, "SCHEDULED");
    assert.equal(db.batches[0]?.status, "SCHEDULED");
    assert.equal(queue.messages.length, 0);
  } finally {
    provider.restore();
  }
});

test("13.4 a still-future scheduled cancel is still accepted (202)", async () => {
  const db = seededDb();
  db.campaigns.push({
    id: "c1", name: "Future", sender_id: "DHSC", message: "m", mode: "SCHEDULED",
    schedule_date: "2027-01-01T10:00:00Z", status: "SCHEDULED", total_recipients: 5,
    total_batches: 1, completed_batches: 1, failed_batches: 0, invalid_count: 0,
    estimated_credits: 5, is_test: 0, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  db.batches.push({
    id: "b1", campaign_id: "c1", chunk_index: 0, status: "SCHEDULED",
    sendmode_request_id: "req-1", invalid_numbers_json: null, error_message: null,
    updated_at: "2026-01-01T00:00:00Z",
  });
  const queue = new FakeQueue();
  const provider = stubProvider();
  try {
    const app = createApp();
    const res = await app.request("/api/campaigns/c1/cancel", json(), makeEnv(db, queue));
    assert.equal(res.status, 202);
    assert.equal(db.campaigns[0]?.status, "CANCELLING");
    assert.equal(queue.messages.length, 1);
    assert.equal(queue.messages[0]?.type, "CANCEL_BATCH");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 6.6 — POST /api/test-sms
// =======================================================================================

test("6.6 POST /api/test-sms records a flagged test campaign in History and enqueues one dispatch", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider();

  try {
    const app = createApp();
    const res = await app.request(
      "/api/test-sms",
      json({ body: { to: "+447700900123", senderId: "DHSC", message: "Test copy" } }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 202);
    const body = (await res.json()) as { recipient: string; message: string };
    assert.equal(body.recipient, "+447700900123");
    assert.equal(body.message, "Test copy Stop: dhsc.uk/x");

    // Recorded in History: exactly one campaign, flagged is_test, in a terminal-visible queue.
    assert.equal(db.campaigns.length, 1);
    assert.equal(db.campaigns[0]?.is_test, 1);
    assert.equal(db.campaigns[0]?.total_recipients, 1);
    // Its batch is not a real audience chunk.
    assert.equal(db.batches[0]?.chunk_index, -1);

    // One DISPATCH_BATCH carrying the recipient inline (no chunk row exists for it).
    assert.equal(queue.messages.length, 1);
    const msg = queue.messages[0];
    assert.equal(msg?.type, "DISPATCH_BATCH");
    if (msg?.type === "DISPATCH_BATCH") {
      assert.deepEqual(msg.recipients, ["+447700900123"]);
    }
  } finally {
    provider.restore();
  }
});

test("6.6 POST /api/test-sms normalises the number and rejects a non-UK-mobile (400)", async () => {
  const provider = stubProvider();
  try {
    const app = createApp();
    const db = seededDb();

    const normalised = await app.request(
      "/api/test-sms",
      json({ body: { to: "07700 900123", senderId: "DHSC", message: "Hi" } }),
      makeEnv(db, new FakeQueue()),
    );
    assert.equal(normalised.status, 202);
    assert.equal(db.campaigns[0]?.name, "Test SMS → +447700900123");

    const bad = await app.request(
      "/api/test-sms",
      json({ body: { to: "+441234567890", senderId: "DHSC", message: "Hi" } }),
      makeEnv(seededDb(), new FakeQueue()),
    );
    assert.equal(bad.status, 400);
  } finally {
    provider.restore();
  }
});

test("6.6 POST /api/test-sms blocks when the balance cannot cover the single credit (400, nothing written)", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(0); // zero credit available

  try {
    const app = createApp();
    const res = await app.request(
      "/api/test-sms",
      json({ body: { to: "+447700900123", senderId: "DHSC", message: "Test copy" } }),
      makeEnv(db, queue),
    );

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; required: number; available: number };
    assert.equal(body.error, "insufficient_balance");
    assert.equal(body.required, 1);
    assert.equal(body.available, 0);
    // Nothing is written or enqueued on refusal.
    assert.equal(db.campaigns.length, 0);
    assert.equal(queue.messages.length, 0);
  } finally {
    provider.restore();
  }
});

test("6.6 POST /api/test-sms surfaces a balance-provider failure as 502", async () => {
  const provider = stubProvider();
  provider.failStatus = 503;
  try {
    const app = createApp();
    const res = await app.request(
      "/api/test-sms",
      json({ body: { to: "+447700900123", senderId: "DHSC", message: "Test copy" } }),
      makeEnv(seededDb(), new FakeQueue()),
    );
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.equal(body.error, "provider_error");
    assert.equal(body.reason, "server_error");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 6.7 — Opt-outs (authenticated) + public opt-out
// =======================================================================================

test("6.7 authenticated opt-out list/add/remove updates the valid recipient count", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider();

  try {
    const app = createApp();

    // Add
    const added = await app.request(
      "/api/opt-outs",
      json({ body: { number: "07700900001" } }),
      makeEnv(db, queue),
    );
    assert.equal(added.status, 201);
    assert.equal(db.optOuts.length, 1);
    assert.equal(db.optOuts[0]?.mobile_number, "+447700900001");

    // List
    const list = await app.request("/api/opt-outs", {}, makeEnv(db, queue));
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      count: number;
      validRecipientCount: number;
      optOuts: Array<{ number: string }>;
    };
    assert.equal(listBody.count, 1);
    assert.equal(listBody.validRecipientCount, 4); // 5 − 1
    assert.equal(listBody.optOuts[0]?.number, "+447700900001");

    // Duplicate add is idempotent (200, not 201).
    const dup = await app.request(
      "/api/opt-outs",
      json({ body: { number: "+447700900001" } }),
      makeEnv(db, queue),
    );
    assert.equal(dup.status, 200);

    // Remove
    const removed = await app.request(
      "/api/opt-outs/%2B447700900001",
      { method: "DELETE" },
      makeEnv(db, queue),
    );
    assert.equal(removed.status, 200);
    assert.equal(db.optOuts.length, 0);

    // Removing again → 404.
    const again = await app.request(
      "/api/opt-outs/%2B447700900001",
      { method: "DELETE" },
      makeEnv(db, queue),
    );
    assert.equal(again.status, 404);
  } finally {
    provider.restore();
  }
});

test("6.7 authenticated opt-out rejects an invalid number (400) and requires auth", async () => {
  const provider = stubProvider();
  try {
    const app = createApp();

    const bad = await app.request(
      "/api/opt-outs",
      json({ body: { number: "not-a-number" } }),
      makeEnv(seededDb(), new FakeQueue()),
    );
    assert.equal(bad.status, 400);

    // No dev bypass, no Access headers → 401 (the guard covers the group).
    const anonymous = await app.request("/api/opt-outs", {}, {
      DB: seededDb() as unknown as D1Database,
      ASSETS: {} as Fetcher,
      SMS_QUEUE: new FakeQueue() as unknown as Queue,
      SENDMODE_ACCESS_KEY: "test-key",
    });
    assert.equal(anonymous.status, 401);
  } finally {
    provider.restore();
  }
});

test("6.7 public POST /api/opt-out works without auth, normalises JSON, and is idempotent", async () => {
  const db = seededDb();
  const provider = stubProvider();
  const publicEnv: Env = {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: new FakeQueue() as unknown as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
    DEV_AUTH_BYPASS: "false",
  };

  try {
    const app = createApp();

    const res = await app.request(
      "/api/opt-out",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: "07700 900002" }),
      },
      publicEnv,
    );
    assert.equal(res.status, 200); // reachable without any auth
    assert.equal(db.optOuts[0]?.mobile_number, "+447700900002");

    // Submitting again does not duplicate and still returns a neutral success.
    const again = await app.request(
      "/api/opt-out",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: "+447700900002" }),
      },
      publicEnv,
    );
    assert.equal(again.status, 200);
    assert.equal(db.optOuts.length, 1);
  } finally {
    provider.restore();
  }
});

test("6.7 public opt-out accepts a urlencoded form post and rejects a bad number (400)", async () => {
  const db = seededDb();
  const provider = stubProvider();
  const publicEnv: Env = {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: new FakeQueue() as unknown as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
  };

  try {
    const app = createApp();

    const form = await app.request(
      "/api/opt-out",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "number=07700900003",
      },
      publicEnv,
    );
    assert.equal(form.status, 200);
    assert.equal(db.optOuts[0]?.mobile_number, "+447700900003");

    const bad = await app.request(
      "/api/opt-out",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: "12345" }),
      },
      publicEnv,
    );
    assert.equal(bad.status, 400);
  } finally {
    provider.restore();
  }
});
