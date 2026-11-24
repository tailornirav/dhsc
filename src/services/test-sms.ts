/**
 * Test-SMS service — one unscheduled SMS to a single operator-supplied UK number.
 *
 * Mission.md §8.6 / roadmap 6.6 require the test send to be **recorded in History**, flagged
 * as a test. We therefore model it as an ordinary 1-recipient, 1-batch campaign with
 * `is_test = 1`; the History view labels it. Because the number is arbitrary it is **not** in
 * `audience_chunks` (the static audience must never be polluted), so the dispatch message
 * carries the recipient inline (see `DispatchBatchMessage.recipients`).
 *
 * Cost is 1 segment × 1 recipient = 1 credit; it still runs through the queue so the same
 * retry/idempotency path applies as any other send (hard rule #3).
 */

import { insertCampaign, type NewCampaign } from "./campaigns.js";
import { OPT_OUT_SUFFIX } from "../lib/validate.js";
import type { DispatchBatchMessage } from "../queue/messages.js";

/**
 * Sentinel `chunk_index` for a test batch. Uses `-1` so it can never collide with a real
 * chunk (which is `>= 0`) and is obviously not a real audience row to anyone reading the
 * table.
 */
export const TEST_CHUNK_INDEX = -1;

/** A validated test-send request (number already normalised to E.164). */
export interface TestSendRequest {
  /** Normalised `+447…` recipient. */
  recipient: string;
  /** Sender ID to display (validated by the caller). */
  senderId: string;
  /** Operator's message text **without** the suffix. */
  message: string;
  /** Injectable clock, ISO 8601 UTC. */
  now: string;
}

/**
 * Persist the test campaign + its single batch, then enqueue the dispatch. Returns the new
 * campaign id (so the caller can echo it) and the full outbound body (suffix included) for
 * confirmation UI.
 */
export async function createTestSend(
  db: D1Database,
  queue: Queue<DispatchBatchMessage>,
  request: TestSendRequest,
): Promise<{ campaignId: string; batchId: string; fullMessage: string }> {
  const campaignId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const fullMessage = `${request.message} ${OPT_OUT_SUFFIX}`;

  const campaign: NewCampaign = {
    id: campaignId,
    name: `Test SMS → ${request.recipient}`,
    senderId: request.senderId,
    message: fullMessage,
    mode: "IMMEDIATE",
    scheduleDateUtc: null,
    // One segment, one recipient.
    estimatedCredits: 1,
    totalRecipients: 1,
    isTest: true,
    batches: [{ id: batchId, chunkIndex: TEST_CHUNK_INDEX, recipients: [request.recipient] }],
    now: request.now,
  };

  await insertCampaign(db, campaign);

  await queue.sendBatch([
    {
      body: {
        type: "DISPATCH_BATCH",
        campaignId,
        batchId,
        chunkIndex: TEST_CHUNK_INDEX,
        recipients: [request.recipient],
      } satisfies DispatchBatchMessage,
    },
  ]);

  return { campaignId, batchId, fullMessage };
}
