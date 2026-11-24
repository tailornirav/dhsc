/**
 * `CANCEL_BATCH` queue handler — cancels one scheduled provider job (tech.md Flow C, roadmap
 * 7.2 + 7.4 + 7.5).
 *
 * Cancellation runs through the queue because Sendmode needs one `DELETE /3.0/schedule` per
 * `request_id` (tech.md Flow B). Like the dispatch handler it is safe under retries (hard rule
 * #11): a batch already `CANCELLED` is acked and skipped, and transient provider failures are
 * retried with backoff.
 *
 * Flow (tech.md Flow C, `CANCEL_BATCH`):
 *   1. Load the batch; a missing row is acked (nothing to do).
 *   2. If already `CANCELLED`, ack and skip.
 *   3. `DELETE /3.0/schedule` with the batch's `request_id`.
 *   4. `200` + `is_successful` → mark `CANCELLED`; retry on `5xx`/`429`/network; treat a
 *      non-retryable `400`/`401` as settled too (the provider will never accept the delete, so
 *      we mark the batch `CANCELLED` locally to let the campaign settle — the operator has
 *      already decided to stop it).
 *   5. Recompute the campaign aggregate; once **no** batch is `PENDING` or `SCHEDULED` (every
 *      provider job has been deleted) and at least one was `CANCELLED`, the campaign settles to
 *      `CANCELLED`. A still-live `SCHEDULED` sibling keeps the campaign in `CANCELLING` so the
 *      UI never claims a job is cancelled while it can still fire (tech.md Flow C step 4).
 */

import { firstRow } from "../db/client.js";
import { cancelSchedule, type SendmodeConfig, type SendmodeResult, type CancelScheduleResponse } from "../services/sendmode.js";
import { nowUtcIso } from "../lib/uk-time.js";
import type { CancelBatchMessage } from "./messages.js";
import { recomputeCampaign } from "./campaign-status.js";
import { isTransient } from "./dispatch.js";

/** The batch columns the cancel handler needs. */
interface BatchRow {
  id: string;
  campaign_id: string;
  status: string;
  sendmode_request_id: string | null;
}

/** Structural deps so the handler is unit-testable without a Worker runtime. */
export interface CancelDeps {
  db: D1Database;
  sendmode: SendmodeConfig;
  now?: () => string;
}

/** Outcome of one `CANCEL_BATCH` message: what the caller should do with the message. */
export type CancelOutcome =
  | { action: "ack"; reason: string }
  | { action: "retry"; delaySeconds: number; reason: string };

/**
 * Run the cancel flow for one message. `attempts` is `msg.attempts`; transient failures retry
 * after `10 * attempts` seconds (roadmap 7.4), matching the dispatch policy.
 */
export async function handleCancel(
  message: CancelBatchMessage,
  deps: CancelDeps,
  attempts: number,
): Promise<CancelOutcome> {
  const now = deps.now ?? nowUtcIso;

  const batch = await firstRow<BatchRow>(
    deps.db,
    "SELECT id, campaign_id, status, sendmode_request_id FROM campaign_batches WHERE id = ?",
    message.batchId,
  );
  if (!batch) return { action: "ack", reason: `batch ${message.batchId} not found` };

  // Idempotency guard: already cancelled (a retry after success), nothing to delete.
  if (batch.status === "CANCELLED") {
    await recomputeCampaign(deps.db, batch.campaign_id, now());
    return { action: "ack", reason: "batch already cancelled" };
  }

  // Prefer the request id from the message (captured when the batch was scheduled); fall back
  // to the freshly-read row so a lost payload field cannot strand a cancellation.
  const requestId = message.requestId || batch.sendmode_request_id;
  if (!requestId) {
    // Nothing to delete at the provider; retire locally so the campaign can settle.
    await markCancelled(deps.db, batch.id, now());
    await recomputeCampaign(deps.db, batch.campaign_id, now());
    return { action: "ack", reason: "no request id to cancel" };
  }

  const result: SendmodeResult<CancelScheduleResponse> = await cancelSchedule(deps.sendmode, requestId);

  if (!result.ok) {
    if (isTransient(result.reason)) {
      return { action: "retry", delaySeconds: 10 * Math.max(1, attempts), reason: result.reason };
    }
    // Non-retryable (400/401/invalid body): the provider will never accept the delete, but the
    // operator has asked to cancel — retire the batch locally so the campaign settles rather
    // than hanging in CANCELLING forever.
    await markCancelled(deps.db, batch.id, now());
    await recomputeCampaign(deps.db, batch.campaign_id, now());
    return { action: "ack", reason: `terminal provider error: ${result.reason}` };
  }

  // `200` + `is_successful: false` ⇒ the provider refused the delete; retire locally for the
  // same reason as above.
  await markCancelled(deps.db, batch.id, now());
  await recomputeCampaign(deps.db, batch.campaign_id, now());
  return { action: "ack", reason: result.data.is_successful ? "cancelled" : "provider refused" };
}

/** Mark a batch `CANCELLED` locally. */
async function markCancelled(db: D1Database, batchId: string, now: string): Promise<void> {
  await db
    .prepare("UPDATE campaign_batches SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
    .bind(now, batchId)
    .run();
}
