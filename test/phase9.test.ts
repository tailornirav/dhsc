/**
 * Phase 9 verification — End-to-End Wiring.
 *
 *   npm test        # runs everything under test/
 *
 * Every earlier phase tested one layer in isolation (Sendmode service, auth, HTTP routes, queue
 * handlers, client mirrors). Phase 9 is the integration phase: it proves the layers are wired
 * **together** into the five flows the mission promises (mission.md §4). Rather than start a real
 * `wrangler dev` run — which would call the **live** provider and spend real, irreversible money
 * (agent.md §4 rule 1, mission.md §6.1) — this suite drives the *real* HTTP app (`createApp()`
 * request → response) and the *real* queue consumer (`worker.queue()`) against the in-memory D1 /
 * queue fakes and a stubbed provider. The result is the same request/response evidence a full-stack
 * walk produces, made reproducible and free.
 *
 * Flows walked (roadmap Phase 9), each asserting the observable state at every hop:
 *   9.1 Immediate campaign:  create → queue → batches SENT → History shows it.
 *   9.2 Scheduled campaign:  create → batches SCHEDULED → Queued view + countdown.
 *   9.3 Cancellation:        cancel → CANCELLING → provider DELETE per request_id → CANCELLED.
 *   9.4 Test SMS:            create → queue → SENT, recorded in History flagged `isTest`.
 *   9.5 Opt-outs:            add/remove changes the valid recipient count everywhere.
 *
 * The doubles live in `test/helpers/fakes.ts`; the queue message/batch doubles live below so the
 * assertions can read the consumer's ack/retry decisions (mirroring `test/phase7.test.ts`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import worker, { createApp, type Env } from "../src/index.js";
import type { QueueMessage } from "../src/queue/messages.js";
import { FakeD1, FakeQueue, stubProvider } from "./helpers/fakes.js";
import { nextSlotLocalValue } from "../web/src/lib/time.js";

// ---------------------------------------------------------------------------------------
// Harness — one Worker env backed by the fakes, plus a "drain the queue" step that runs the
// real consumer over the messages the producer enqueued.
// ---------------------------------------------------------------------------------------

/** A dev-authenticated env backed by the given fakes (mirrors `test/phase6/7`). */
function makeEnv(db: FakeD1, queue: FakeQueue): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: queue as unknown as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
    DEV_AUTH_BYPASS: "true",
  };
}

/** Records whether a message was acked or retried (and with what delay). */
interface MessageDouble {
  body: QueueMessage;
  attempts: number;
  acked: boolean;
  retriedWith: number | null;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/**
 * Take every message the producer enqueued and feed it through the **real** `worker.queue()`
 * consumer, exactly as Cloudflare would deliver it. Returns the message doubles so a test can
 * assert ack/retry, and clears the producer queue so a later drain sees only new work.
 */
async function drainQueue(
  queue: FakeQueue,
  env: Env,
): Promise<MessageDouble[]> {
  const messages: MessageDouble[] = queue.messages.map((body): MessageDouble => ({
    body,
    attempts: 1,
    acked: false,
    retriedWith: null,
    ack() {
      this.acked = true;
    },
    retry(options) {
      this.retriedWith = options?.delaySeconds ?? 0;
    },
  }));

  const batch = {
    messages,
    queue: "sms-campaign-jobs",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<QueueMessage>;

  await worker.queue(batch, env);
  queue.messages = [];
  return messages;
}

/** Standard authenticated JSON request init. */
function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Two audience chunks: 2 + 1 = 3 clean recipients. */
function seededDb(): FakeD1 {
  const db = new FakeD1();
  db.seedAudience([["+447700900001", "+447700900002"], ["+447700900003"]]);
  return db;
}

/** Shape of the campaign-detail response we assert against. */
interface DetailBody {
  campaign: {
    id: string;
    status: string;
    totalRecipients: number;
    totalBatches: number;
    completedBatches: number;
    invalidCount: number;
    isTest: boolean;
  };
  batches: Array<{ status: string; requestId: string | null; invalidNumbers: string[] }>;
}

/** `GET /api/campaigns/:id`, parsed. */
async function getDetail(app: ReturnType<typeof createApp>, env: Env, id: string): Promise<DetailBody> {
  const res = await app.request(`/api/campaigns/${id}`, {}, env);
  assert.equal(res.status, 200, "campaign detail should be 200");
  return (await res.json()) as DetailBody;
}

// =======================================================================================
// 9.1 — Immediate campaign end-to-end
// =======================================================================================

test("9.1 immediate campaign: create → queue → batches SENT → History shows it", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const env = makeEnv(db, queue);

    // --- request: create the campaign (Flow A) ----------------------------------------
    const created = await app.request(
      "/api/campaigns",
      json({ name: "Spring Promo", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" }),
      env,
    );
    assert.equal(created.status, 202, "create should be 202 Accepted");
    const body = (await created.json()) as { id: string; status: string; totalBatches: number };
    assert.equal(body.status, "QUEUED");
    assert.equal(body.totalBatches, 2);

    // Response evidence: the campaign + batches are persisted and the queue holds one
    // DISPATCH_BATCH per batch (never a provider call inside the request — hard rule #3).
    assert.equal(db.campaigns[0]?.status, "QUEUED");
    assert.deepEqual(db.batches.map((b) => b.status), ["PENDING", "PENDING"]);
    assert.equal(queue.messages.length, 2);
    assert.deepEqual(queue.messages.map((m) => m.type), ["DISPATCH_BATCH", "DISPATCH_BATCH"]);
    assert.equal(provider.calls.filter((c) => c.url.includes("/balance")).length, 1, "one pre-flight balance check");

    // --- consumer: drain the queue -----------------------------------------------------
    const drained = await drainQueue(queue, env);
    assert.deepEqual(drained.map((m) => [m.acked, m.retriedWith]), [[true, null], [true, null]]);

    // Response evidence: two provider bulk sends, no scheduling, and SENT batches.
    const sends = provider.calls.filter((c) => c.url.includes("/send/bulk"));
    assert.equal(sends.length, 2, "one bulk send per batch");
    assert.equal(provider.calls.filter((c) => c.url.includes("/schedule/bulk")).length, 0);

    const detail = await getDetail(app, env, body.id);
    assert.equal(detail.campaign.status, "SENT");
    assert.equal(detail.campaign.completedBatches, 2);
    assert.deepEqual(detail.batches.map((b) => b.status), ["SENT", "SENT"]);
    assert.ok(detail.batches.every((b) => b.requestId !== null), "each batch stores its request id");

    // History view shows the settled campaign.
    const history = (await (await app.request("/api/campaigns?filter=history", {}, env)).json()) as {
      campaigns: Array<{ id: string; status: string; isTest: boolean }>;
    };
    const row = history.campaigns.find((c) => c.id === body.id);
    assert.ok(row, "campaign appears in History");
    assert.equal(row?.status, "SENT");
    assert.equal(row?.isTest, false);
  } finally {
    provider.restore();
  }
});

test("9.1 a provider-rejected number surfaces as invalidCount without failing the send", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);
  provider.invalidNumbers = ["+447700900003"];

  try {
    const app = createApp();
    const env = makeEnv(db, queue);
    const created = await app.request(
      "/api/campaigns",
      json({ name: "Promo", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" }),
      env,
    );
    const { id } = (await created.json()) as { id: string };

    await drainQueue(queue, env);

    const detail = await getDetail(app, env, id);
    assert.equal(detail.campaign.status, "SENT", "a rejected number is not a batch failure");
    // The stub echoes `invalidNumbers` on every bulk call, so each batch reports the list and the
    // campaign aggregate is the sum across batches (tech.md Flow C step 4: count from batch rows).
    const perBatch = detail.batches.reduce((sum, b) => sum + b.invalidNumbers.length, 0);
    assert.equal(detail.campaign.invalidCount, perBatch);
    assert.ok(detail.batches.some((b) => b.invalidNumbers.includes("+447700900003")));
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 9.2 — Scheduled campaign end-to-end
// =======================================================================================

test("9.2 scheduled campaign: create → batches SCHEDULED → Queued view + countdown", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);
  provider.requestId = "req-sched-1";

  try {
    const app = createApp();
    const env = makeEnv(db, queue);
    // A real future slot the server accepts (the client helper the picker uses).
    const scheduleLocal = nextSlotLocalValue();

    const created = await app.request(
      "/api/campaigns",
      json({ name: "Schedule Later", senderId: "DHSC", message: "Hi", mode: "SCHEDULED", scheduleLocal }),
      env,
    );
    assert.equal(created.status, 202);
    const { id } = (await created.json()) as { id: string };

    await drainQueue(queue, env);

    // Response evidence: scheduled bulk endpoints used, not send.
    assert.equal(provider.calls.filter((c) => c.url.includes("/schedule/bulk")).length, 2);
    assert.equal(provider.calls.filter((c) => c.url.includes("/send/bulk")).length, 0);

    const detail = await getDetail(app, env, id);
    assert.equal(detail.campaign.status, "SCHEDULED");
    assert.deepEqual(detail.batches.map((b) => b.status), ["SCHEDULED", "SCHEDULED"]);
    assert.ok(detail.batches.every((b) => b.requestId === "req-sched-1"));
    assert.equal(detail.campaign.completedBatches, 2);

    // The Queued (upcoming) view lists it with a future schedule date → the card renders a
    // countdown from `scheduleDate` (QueuedHistoryPanel / describeCountdown).
    const upcoming = (await (
      await app.request("/api/campaigns?filter=upcoming", {}, env)
    ).json()) as { campaigns: Array<{ id: string; status: string; scheduleDate: string | null }> };
    const row = upcoming.campaigns.find((c) => c.id === id);
    assert.ok(row, "scheduled campaign appears in the Queued view");
    assert.equal(row?.status, "SCHEDULED");
    assert.ok(row?.scheduleDate && new Date(row.scheduleDate).getTime() > Date.now(), "schedule date is in the future");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 9.3 — Cancellation end-to-end
// =======================================================================================

test("9.3 cancellation: cancel → CANCELLING → provider DELETEs per request_id → CANCELLED", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);
  provider.requestId = "req-sched-xyz";

  try {
    const app = createApp();
    const env = makeEnv(db, queue);
    const created = await app.request(
      "/api/campaigns",
      json({ name: "Cancel Me", senderId: "DHSC", message: "Hi", mode: "SCHEDULED", scheduleLocal: nextSlotLocalValue() }),
      env,
    );
    const { id } = (await created.json()) as { id: string };

    // Drain the dispatch jobs first so the batches are live SCHEDULED provider jobs.
    await drainQueue(queue, env);
    assert.equal((await getDetail(app, env, id)).campaign.status, "SCHEDULED");

    // --- request: cancel (Flow B) ------------------------------------------------------
    const cancelled = await app.request(`/api/campaigns/${id}/cancel`, { method: "POST" }, env);
    assert.equal(cancelled.status, 202);
    const cancelBody = (await cancelled.json()) as { status: string; enqueued: number };
    assert.equal(cancelBody.status, "CANCELLING");
    assert.equal(cancelBody.enqueued, 2, "one cancel job per scheduled batch");

    // Response evidence: the campaign is CANCELLING immediately; CANCEL_BATCH jobs are queued.
    assert.equal(db.campaigns[0]?.status, "CANCELLING");
    assert.deepEqual(queue.messages.map((m) => m.type), ["CANCEL_BATCH", "CANCEL_BATCH"]);

    // --- consumer: drain the cancel jobs -----------------------------------------------
    await drainQueue(queue, env);

    // Response evidence: one DELETE /3.0/schedule per request_id, with the right id.
    const deletes = provider.calls.filter((c) => c.method === "DELETE" && c.url.includes("/schedule"));
    assert.equal(deletes.length, 2, "one provider delete per scheduled batch");
    const deleteBodies = provider.bodies.filter(
      (b) => typeof b === "object" && b !== null && "request_id" in (b as object),
    ) as Array<{ request_id: string }>;
    assert.ok(deleteBodies.every((b) => b.request_id === "req-sched-xyz"));

    const detail = await getDetail(app, env, id);
    assert.equal(detail.campaign.status, "CANCELLED");
    assert.deepEqual(detail.batches.map((b) => b.status), ["CANCELLED", "CANCELLED"]);
  } finally {
    provider.restore();
  }
});

test("9.3 cancelling before dispatch never reaches the provider (race guard)", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const env = makeEnv(db, queue);
    const created = await app.request(
      "/api/campaigns",
      json({ name: "Race", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" }),
      env,
    );
    const { id } = (await created.json()) as { id: string };

    // Cancel while the DISPATCH_BATCH jobs are still sitting in the queue (nothing sent yet).
    const cancelled = await app.request(`/api/campaigns/${id}/cancel`, { method: "POST" }, env);
    assert.equal(cancelled.status, 202);
    assert.equal(((await cancelled.json()) as { enqueued: number }).enqueued, 0);

    // Now drain the stale dispatch jobs — the race guard must retire them, not send them.
    await drainQueue(queue, env);

    assert.equal(provider.calls.filter((c) => c.url.includes("/send/bulk")).length, 0, "no send after cancel");
    const detail = await getDetail(app, env, id);
    assert.equal(detail.campaign.status, "CANCELLED");
    assert.deepEqual(detail.batches.map((b) => b.status), ["CANCELLED", "CANCELLED"]);
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 9.4 — Test SMS end-to-end
// =======================================================================================

test("9.4 test SMS: create → queue → SENT, recorded in History flagged isTest", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const env = makeEnv(db, queue);

    const sent = await app.request(
      "/api/test-sms",
      json({ senderId: "DHSC", message: "Test copy", to: "07700 900099" }),
      env,
    );
    assert.equal(sent.status, 202);
    const body = (await sent.json()) as { id: string; recipient: string; message: string };
    assert.equal(body.recipient, "+447700900099", "the number is normalised to E.164");
    assert.ok(body.message.endsWith("Stop: dhsc.uk/x"), "the opt-out suffix is appended");

    // One DISPATCH_BATCH carrying the inline recipient (a test send has no audience chunk).
    assert.equal(queue.messages.length, 1);
    const msg = queue.messages[0];
    assert.equal(msg?.type, "DISPATCH_BATCH");
    assert.deepEqual(msg && "recipients" in msg ? msg.recipients : null, ["+447700900099"]);

    await drainQueue(queue, env);

    const sends = provider.calls.filter((c) => c.url.includes("/send/bulk"));
    assert.equal(sends.length, 1);
    const sendBodies = provider.bodies.filter(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && "mobile_numbers" in (b as object),
    );
    assert.deepEqual(sendBodies[0], {
      sender_id: "DHSC",
      message: "Test copy Stop: dhsc.uk/x",
      mobile_numbers: ["+447700900099"],
      customer_id: db.batches[0]?.id,
      tags: ["Test SMS → +447700900099"],
    });

    const detail = await getDetail(app, env, body.id);
    assert.equal(detail.campaign.status, "SENT");
    assert.equal(detail.campaign.isTest, true, "the campaign is flagged as a test send");
    assert.equal(detail.campaign.totalRecipients, 1);
    assert.deepEqual(detail.batches.map((b) => b.status), ["SENT"]);

    const history = (await (await app.request("/api/campaigns?filter=history", {}, env)).json()) as {
      campaigns: Array<{ id: string; isTest: boolean }>;
    };
    assert.equal(history.campaigns.find((c) => c.id === body.id)?.isTest, true, "History labels it a test");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 9.5 — Opt-out add/remove updates the valid recipient count everywhere
// =======================================================================================

test("9.5 opt-out add/remove updates the valid recipient count everywhere", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const env = makeEnv(db, queue);

    // Baseline: 3 clean recipients, no opt-outs.
    let balance = (await (await app.request("/api/balance", {}, env)).json()) as { audience_count: number };
    assert.equal(balance.audience_count, 3);

    // --- add (authenticated) -----------------------------------------------------------
    const added = await app.request("/api/opt-outs", json({ number: "07700900001" }), env);
    assert.equal(added.status, 201);
    const addBody = (await added.json()) as { number: string; added: boolean; validRecipientCount: number };
    assert.equal(addBody.number, "+447700900001");
    assert.equal(addBody.added, true);
    assert.equal(addBody.validRecipientCount, 2, "add reports the new valid count");

    // The count is reflected by balance, opt-outs, and — crucially — campaign creation.
    balance = (await (await app.request("/api/balance", {}, env)).json()) as { audience_count: number };
    assert.equal(balance.audience_count, 2, "balance audience count drops");
    const list = (await (await app.request("/api/opt-outs", {}, env)).json()) as {
      count: number;
      validRecipientCount: number;
    };
    assert.deepEqual([list.count, list.validRecipientCount], [1, 2]);

    const created = await app.request(
      "/api/campaigns",
      json({ name: "After OptOut", senderId: "DHSC", message: "Hi", mode: "IMMEDIATE" }),
      env,
    );
    const createBody = (await created.json()) as { id: string; totalRecipients: number };
    assert.equal(createBody.totalRecipients, 2, "the opted-out number is stripped from the audience");

    // The batch that actually sends excludes the opted-out number (respect the blacklist). The
    // producer strips opt-outs and passes the stripped list to the consumer, so no batch may
    // contain it.
    await drainQueue(queue, env);
    const sendBodies = provider.bodies.filter(
      (b): b is { mobile_numbers: string[] } =>
        typeof b === "object" && b !== null && "mobile_numbers" in (b as object),
    );
    assert.equal(sendBodies.length, 2, "both chunks dispatched");
    assert.ok(
      sendBodies.every((b) => !b.mobile_numbers.includes("+447700900001")),
      "opted-out number is never sent to",
    );

    // --- remove ------------------------------------------------------------------------
    const removed = await app.request("/api/opt-outs/+447700900001", { method: "DELETE" }, env);
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { validRecipientCount: number }).validRecipientCount, 3);

    balance = (await (await app.request("/api/balance", {}, env)).json()) as { audience_count: number };
    assert.equal(balance.audience_count, 3, "removing restores the valid count");
    assert.equal(db.optOuts.length, 0);
  } finally {
    provider.restore();
  }
});

test("9.5 the public opt-out route updates the count with no auth and is idempotent", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    // Two envs: the public POST refuses the dev identity (its path is the unauthenticated
    // carve-out), while the authenticated reads below need the dev identity to pass the guard.
    const publicEnv: Env = {
      DB: db as unknown as D1Database,
      ASSETS: {} as Fetcher,
      SMS_QUEUE: queue as unknown as Queue,
      SENDMODE_ACCESS_KEY: "test-key",
    };
    const env = makeEnv(db, queue);

    const first = await app.request("/api/opt-out", json({ number: "07700900002" }), publicEnv);
    assert.equal(first.status, 200);

    const balance = (await (await app.request("/api/balance", {}, env)).json()) as { audience_count: number };
    assert.equal(balance.audience_count, 2, "the public opt-out is honoured by the audience count");

    // Idempotent: the second submit is still a neutral success and does not double-count.
    const second = await app.request("/api/opt-out", json({ number: "07700900002" }), publicEnv);
    assert.equal(second.status, 200);
    assert.equal(db.optOuts.length, 1);
  } finally {
    provider.restore();
  }
});
