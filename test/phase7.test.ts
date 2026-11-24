/**
 * Phase 7 verification — Queue Consumer.
 *
 *   npm test        # runs everything under test/
 *
 * Coverage matches roadmap Phase 7 "Verify": with a mocked provider, drive the real `queue()`
 * export and assert that
 *   - a batch transitions PENDING → SENT (immediate) / SCHEDULED (scheduled) and the campaign
 *     reaches the right terminal status;
 *   - cancelling mid-flight skips the send (batch → CANCELLED, campaign → CANCELLED);
 *   - retries fire on 429/5xx/network with the `10 * attempts` backoff, and 400/401 fail the
 *     batch terminally;
 *   - `CANCEL_BATCH` deletes the provider job and settles the campaign;
 *   - idempotency: a re-delivered message is acked without a second provider call.
 *
 * The doubles live in `test/helpers/fakes.ts`; the queue batch/message doubles live below so
 * the assertions can read `ack`/`retry` decisions directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../src/index.js";
import type { QueueMessage } from "../src/queue/messages.js";
import { FakeD1, FakeQueue, stubProvider } from "./helpers/fakes.js";

// ---------------------------------------------------------------------------------------
// Queue message / batch doubles
// ---------------------------------------------------------------------------------------

/** Records whether a message was acked or retried (and with what delay). */
interface MessageDouble {
  id: string;
  body: QueueMessage;
  attempts: number;
  acked: boolean;
  retriedWith: number | null;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Build a message double at the given attempt count (1 = first delivery). */
function message(body: QueueMessage, attempts = 1): MessageDouble {
  const msg: MessageDouble = {
    id: crypto.randomUUID(),
    body,
    attempts,
    acked: false,
    retriedWith: null,
    ack() {
      this.acked = true;
    },
    retry(options) {
      this.retriedWith = options?.delaySeconds ?? 0;
    },
  };
  return msg;
}

/** A `MessageBatch` double over the given messages. */
function batchOf(messages: MessageDouble[]): MessageBatch<QueueMessage> {
  return {
    messages,
    queue: "sms-campaign-jobs",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<QueueMessage>;
}

/** Run the Worker's queue consumer over the given messages. */
async function runQueue(messages: MessageDouble[], env: Env): Promise<void> {
  await worker.queue(batchOf(messages), env);
}

/** A dev env backed by the given fakes. */
function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: new FakeQueue() as unknown as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
    DEV_AUTH_BYPASS: "true",
  };
}

/** Seed one campaign + batches directly into the fake D1. */
function seedCampaign(
  db: FakeD1,
  overrides: Partial<{
    id: string;
    name: string;
    mode: string;
    schedule_date: string | null;
    status: string;
    total_recipients: number;
    total_batches: number;
  }> = {},
): { id: string } {
  const id = overrides.id ?? "camp-1";
  db.campaigns.push({
    id,
    name: overrides.name ?? "Spring Promo",
    sender_id: "DHSC",
    message: "Hello! Stop: dhsc.uk/x",
    mode: overrides.mode ?? "IMMEDIATE",
    schedule_date: overrides.schedule_date ?? null,
    status: overrides.status ?? "QUEUED",
    total_recipients: overrides.total_recipients ?? 5,
    total_batches: overrides.total_batches ?? 2,
    completed_batches: 0,
    failed_batches: 0,
    invalid_count: 0,
    estimated_credits: 5,
    is_test: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  return { id };
}

/** Seed a batch row for a campaign. */
function seedBatch(
  db: FakeD1,
  overrides: Partial<{
    id: string;
    campaign_id: string;
    chunk_index: number;
    status: string;
    sendmode_request_id: string | null;
  }> = {},
): void {
  db.batches.push({
    id: overrides.id ?? "b1",
    campaign_id: overrides.campaign_id ?? "camp-1",
    chunk_index: overrides.chunk_index ?? 0,
    status: overrides.status ?? "PENDING",
    sendmode_request_id: overrides.sendmode_request_id ?? null,
    invalid_numbers_json: null,
    error_message: null,
    updated_at: "2026-01-01T00:00:00Z",
  });
}

// =======================================================================================
// 7.1 / 7.5 — DISPATCH_BATCH success + campaign terminal status
// =======================================================================================

test("7.1 DISPATCH_BATCH sends a chunk, records SENT + request_id, and settles the campaign to SENT", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001", "+447700900002"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 2 });
  seedBatch(db, { id: "b1" });

  const provider = stubProvider();
  provider.requestId = "req-abc";
  provider.invalidNumbers = ["+447700900999"];

  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, true);
    assert.equal(msg.retriedWith, null);

    // One provider call to the bulk send endpoint, with the batch id + campaign name tags.
    const send = provider.calls.find((c) => c.url.includes("/send/bulk"));
    assert.ok(send, "expected a POST /send/bulk call");
    const body = provider.bodies[provider.calls.indexOf(send)] as {
      mobile_numbers: string[];
      customer_id: string;
      tags: string[];
    };
    assert.deepEqual(body.mobile_numbers, ["+447700900001", "+447700900002"]);
    assert.equal(body.customer_id, "b1");
    assert.deepEqual(body.tags, ["Spring Promo"]);

    // Batch persisted as SENT with the request id + invalid numbers.
    const b = db.batches.find((x) => x.id === "b1");
    assert.equal(b?.status, "SENT");
    assert.equal(b?.sendmode_request_id, "req-abc");
    assert.deepEqual(JSON.parse(b?.invalid_numbers_json ?? "[]"), ["+447700900999"]);

    // Campaign settled to SENT with counters recomputed.
    const camp = db.campaigns.find((c) => c.id === "camp-1");
    assert.equal(camp?.status, "SENT");
    assert.equal(camp?.completed_batches, 1);
    assert.equal(camp?.invalid_count, 1);
  } finally {
    provider.restore();
  }
});

test("7.1 DISPATCH_BATCH schedules with schedule_date and settles the campaign to SCHEDULED", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { mode: "SCHEDULED", schedule_date: "2027-01-01T10:00:00Z", total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1" });

  const provider = stubProvider();
  provider.requestId = "req-sched";

  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, true);
    const sched = provider.calls.find((c) => c.url.includes("/schedule/bulk"));
    assert.ok(sched, "expected a POST /schedule/bulk call");
    const body = provider.bodies[provider.calls.indexOf(sched)] as { schedule_date: string };
    assert.equal(body.schedule_date, "2027-01-01T10:00:00Z");

    assert.equal(db.batches[0]?.status, "SCHEDULED");
    assert.equal(db.campaigns[0]?.status, "SCHEDULED");
  } finally {
    provider.restore();
  }
});

test("7.5 a campaign only settles once every batch is done (PENDING keeps it in flight)", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"], ["+447700900002"]]);
  seedCampaign(db, { total_batches: 2, total_recipients: 2 });
  seedBatch(db, { id: "b1", chunk_index: 0 });
  seedBatch(db, { id: "b2", chunk_index: 1 });

  const provider = stubProvider();

  try {
    // Deliver only the first batch: the campaign must NOT settle while b2 is PENDING.
    const first = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    await runQueue([first], makeEnv(db));
    assert.equal(first.acked, true);
    assert.equal(db.batches.find((b) => b.id === "b1")?.status, "SENT");
    assert.equal(db.campaigns[0]?.completed_batches, 1);
    assert.notEqual(db.campaigns[0]?.status, "SENT"); // still QUEUED — one batch left

    // Deliver the second: now the campaign settles to SENT.
    const second = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b2", chunkIndex: 1 });
    await runQueue([second], makeEnv(db));
    assert.equal(db.campaigns[0]?.status, "SENT");
    assert.equal(db.campaigns[0]?.completed_batches, 2);
  } finally {
    provider.restore();
  }
});

test("7.5 a batch failure with a sibling success settles the campaign to PARTIAL_FAILURE", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"], ["+447700900002"]]);
  seedCampaign(db, { total_batches: 2, total_recipients: 2 });
  seedBatch(db, { id: "b1", chunk_index: 0 });
  seedBatch(db, { id: "b2", chunk_index: 1 });

  const provider = stubProvider();

  try {
    // b1 succeeds.
    await runQueue(
      [message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 })],
      makeEnv(db),
    );
    // b2 hits a non-retryable 400 → FAILED.
    provider.failStatus = 400;
    const bad = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b2", chunkIndex: 1 });
    await runQueue([bad], makeEnv(db));
    assert.equal(bad.acked, true);

    assert.equal(db.batches.find((b) => b.id === "b2")?.status, "FAILED");
    assert.equal(db.campaigns[0]?.status, "PARTIAL_FAILURE");
    assert.equal(db.campaigns[0]?.failed_batches, 1);
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 7.1 — idempotency + cancel race guards
// =======================================================================================

test("7.1 a re-delivered batch (already SENT) is acked without a second provider call", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1", status: "SENT", sendmode_request_id: "req-existing" });

  const provider = stubProvider();
  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, true);
    assert.equal(provider.calls.length, 0, "no provider call for an already-sent batch");
    // The aggregate is still recomputed (idempotent heal).
    assert.equal(db.campaigns[0]?.status, "SENT");
  } finally {
    provider.restore();
  }
});

test("7.1 a batch for a CANCELLING campaign is retired as CANCELLED and never sent", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { status: "CANCELLING", total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1", status: "PENDING" });

  const provider = stubProvider();
  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, true);
    assert.equal(provider.calls.length, 0, "a cancelling campaign must not call the provider");
    assert.equal(db.batches[0]?.status, "CANCELLED");
    assert.equal(db.campaigns[0]?.status, "CANCELLED");
  } finally {
    provider.restore();
  }
});

test("7.1 an unknown/missing campaign or batch is acked (no retry loop)", async () => {
  const db = new FakeD1();
  const provider = stubProvider();
  try {
    const missingCampaign = message({ type: "DISPATCH_BATCH", campaignId: "nope", batchId: "b1", chunkIndex: 0 });
    const missingBatch = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "nope", chunkIndex: 0 });
    db.campaigns.push({
      id: "camp-1", name: "x", sender_id: "DHSC", message: "m", mode: "IMMEDIATE",
      schedule_date: null, status: "QUEUED", total_recipients: 1, total_batches: 1,
      completed_batches: 0, failed_batches: 0, invalid_count: 0, estimated_credits: 1,
      is_test: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });

    await runQueue([missingCampaign, missingBatch], makeEnv(db));
    assert.equal(missingCampaign.acked, true);
    assert.equal(missingBatch.acked, true);
    assert.equal(provider.calls.length, 0);
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 7.4 — retry policy
// =======================================================================================

test("7.4 a 5xx provider failure retries with 10 * attempts backoff and leaves the batch PENDING", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1" });

  const provider = stubProvider();
  provider.failStatus = 503;

  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 }, 3);
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, false);
    assert.equal(msg.retriedWith, 30); // 10 * 3
    assert.equal(db.batches[0]?.status, "PENDING", "a transient failure must not change the batch");
    assert.notEqual(db.campaigns[0]?.status, "SENT");
  } finally {
    provider.restore();
  }
});

test("7.4 a 429 retries (rate-limited is transient)", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1" });

  const provider = stubProvider();
  provider.failStatus = 429;

  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 }, 1);
    await runQueue([msg], makeEnv(db));
    assert.equal(msg.retriedWith, 10); // 10 * 1
    assert.equal(db.batches[0]?.status, "PENDING");
  } finally {
    provider.restore();
  }
});

test("7.4 a 400 marks the batch FAILED terminally (no retry) and settles the campaign", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1" });

  const provider = stubProvider();
  provider.failStatus = 400;

  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, true);
    assert.equal(msg.retriedWith, null);
    assert.equal(db.batches[0]?.status, "FAILED");
    assert.equal(db.campaigns[0]?.status, "PARTIAL_FAILURE");
  } finally {
    provider.restore();
  }
});

test("7.4 a 200 with is_successful:false fails the batch terminally", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1" });

  const provider = stubProvider();
  provider.rejectSuccess = true;

  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    await runQueue([msg], makeEnv(db));
    assert.equal(msg.acked, true);
    assert.equal(db.batches[0]?.status, "FAILED");
  } finally {
    provider.restore();
  }
});

test("7.4 a network error retries", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1" });

  // Install a fetch that throws for the send endpoint (transport failure).
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connection reset");
  }) as typeof fetch;

  try {
    const msg = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 }, 2);
    await runQueue([msg], makeEnv(db));
    assert.equal(msg.retriedWith, 20); // 10 * 2
    assert.equal(db.batches[0]?.status, "PENDING");
  } finally {
    globalThis.fetch = original;
  }
});

// =======================================================================================
// 7.1 — test-send inline recipients (no audience row)
// =======================================================================================

test("7.1 a test send uses inline recipients (no audience chunk row)", async () => {
  const db = new FakeD1();
  seedCampaign(db, { name: "Test SMS → +447700900123", total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1", chunk_index: -1 });

  const provider = stubProvider();
  try {
    const msg = message({
      type: "DISPATCH_BATCH",
      campaignId: "camp-1",
      batchId: "b1",
      chunkIndex: -1,
      recipients: ["+447700900123"],
    });
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, true);
    const send = provider.calls.find((c) => c.url.includes("/send/bulk"));
    const body = provider.bodies[provider.calls.indexOf(send!)] as { mobile_numbers: string[] };
    assert.deepEqual(body.mobile_numbers, ["+447700900123"]);
    assert.equal(db.batches[0]?.status, "SENT");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 7.2 — CANCEL_BATCH
// =======================================================================================

test("7.2 CANCEL_BATCH deletes the provider job and settles the campaign to CANCELLED", async () => {
  const db = new FakeD1();
  seedCampaign(db, { mode: "SCHEDULED", schedule_date: "2027-01-01T10:00:00Z", status: "CANCELLING", total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1", status: "SCHEDULED", sendmode_request_id: "req-sched" });

  const provider = stubProvider();
  try {
    const msg = message({ type: "CANCEL_BATCH", campaignId: "camp-1", batchId: "b1", requestId: "req-sched" });
    await runQueue([msg], makeEnv(db));

    assert.equal(msg.acked, true);
    const del = provider.calls.find((c) => c.method === "DELETE");
    assert.ok(del, "expected a DELETE call");
    assert.equal(del.url, "https://sms-rest.sendmode.dev/3.0/schedule");
    const body = provider.bodies[provider.calls.indexOf(del)] as { request_id: string };
    assert.equal(body.request_id, "req-sched");

    assert.equal(db.batches[0]?.status, "CANCELLED");
    assert.equal(db.campaigns[0]?.status, "CANCELLED");
  } finally {
    provider.restore();
  }
});

test("7.2 a re-delivered CANCEL_BATCH (already CANCELLED) is acked without a provider call", async () => {
  const db = new FakeD1();
  seedCampaign(db, { mode: "SCHEDULED", schedule_date: "2027-01-01T10:00:00Z", status: "CANCELLING", total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1", status: "CANCELLED", sendmode_request_id: "req-sched" });

  const provider = stubProvider();
  try {
    const msg = message({ type: "CANCEL_BATCH", campaignId: "camp-1", batchId: "b1", requestId: "req-sched" });
    await runQueue([msg], makeEnv(db));
    assert.equal(msg.acked, true);
    assert.equal(provider.calls.length, 0);
    assert.equal(db.campaigns[0]?.status, "CANCELLED"); // settled on recompute
  } finally {
    provider.restore();
  }
});

test("7.2 a transient cancel failure retries and leaves the batch SCHEDULED", async () => {
  const db = new FakeD1();
  seedCampaign(db, { mode: "SCHEDULED", schedule_date: "2027-01-01T10:00:00Z", status: "CANCELLING", total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1", status: "SCHEDULED", sendmode_request_id: "req-sched" });

  const provider = stubProvider();
  provider.failFor = { "/schedule": 503 };

  try {
    const msg = message({ type: "CANCEL_BATCH", campaignId: "camp-1", batchId: "b1", requestId: "req-sched" }, 2);
    await runQueue([msg], makeEnv(db));
    assert.equal(msg.retriedWith, 20);
    assert.equal(db.batches[0]?.status, "SCHEDULED");
    assert.equal(db.campaigns[0]?.status, "CANCELLING"); // stuck until the retry lands
  } finally {
    provider.restore();
  }
});

test("7.5 a cancelling campaign does NOT settle to CANCELLED while a sibling job is still SCHEDULED", async () => {
  const db = new FakeD1();
  seedCampaign(db, { mode: "SCHEDULED", schedule_date: "2027-01-01T10:00:00Z", status: "CANCELLING", total_batches: 2, total_recipients: 2 });
  // b1 already cancelled; b2's provider job is still live (its DELETE has not landed).
  seedBatch(db, { id: "b1", chunk_index: 0, status: "CANCELLED", sendmode_request_id: "req-1" });
  seedBatch(db, { id: "b2", chunk_index: 1, status: "SCHEDULED", sendmode_request_id: "req-2" });

  const provider = stubProvider();
  provider.failFor = { "/schedule": 503 };

  try {
    const msg = message({ type: "CANCEL_BATCH", campaignId: "camp-1", batchId: "b2", requestId: "req-2" }, 1);
    await runQueue([msg], makeEnv(db));
    // b2's delete failed transiently → the campaign is still CANCELLING (a live job remains).
    assert.equal(msg.retriedWith, 10);
    assert.equal(db.batches.find((b) => b.id === "b2")?.status, "SCHEDULED");
    assert.equal(db.campaigns[0]?.status, "CANCELLING");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 7.3 — routing: an unknown message type is acked, mixed batches processed in order
// =======================================================================================

test("7.3 an unknown message type is acked (no poison loop)", async () => {
  const db = new FakeD1();
  const provider = stubProvider();
  try {
    const msg = message({ type: "SOMETHING_ELSE" } as unknown as QueueMessage);
    await runQueue([msg], makeEnv(db));
    assert.equal(msg.acked, true);
    assert.equal(provider.calls.length, 0);
  } finally {
    provider.restore();
  }
});

test("7.3 a mixed batch processes every message (dispatch + cancel) in one invocation", async () => {
  const db = new FakeD1();
  db.seedAudience([["+447700900001"]]);
  seedCampaign(db, { total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b1" });
  seedCampaign(db, { id: "camp-2", mode: "SCHEDULED", schedule_date: "2027-01-01T10:00:00Z", status: "CANCELLING", total_batches: 1, total_recipients: 1 });
  seedBatch(db, { id: "b2", campaign_id: "camp-2", status: "SCHEDULED", sendmode_request_id: "req-2" });

  const provider = stubProvider();
  try {
    const dispatch = message({ type: "DISPATCH_BATCH", campaignId: "camp-1", batchId: "b1", chunkIndex: 0 });
    const cancel = message({ type: "CANCEL_BATCH", campaignId: "camp-2", batchId: "b2", requestId: "req-2" });
    await runQueue([dispatch, cancel], makeEnv(db));

    assert.equal(dispatch.acked, true);
    assert.equal(cancel.acked, true);
    assert.equal(db.batches.find((b) => b.id === "b1")?.status, "SENT");
    assert.equal(db.batches.find((b) => b.id === "b2")?.status, "CANCELLED");
  } finally {
    provider.restore();
  }
});
