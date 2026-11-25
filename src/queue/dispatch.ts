/**
 * `DISPATCH_BATCH` queue handler — sends (or schedules) one campaign chunk through Sendmode
 * (tech.md Flow C, roadmap 7.1 + 7.4 + 7.5).
 *
 * Each invocation handles exactly one message (the Worker's `queue()` fan-in loop drives the
 * batch). The handler is written to be **safe under retries and out-of-order delivery** (hard
 * rule #11): it re-reads D1 before doing anything and acks without side effects when the batch
 * has already left `PENDING`.
 *
 * Flow (tech.md Flow C, `DISPATCH_BATCH`):
 *   1. Load the campaign and the batch. The recipients come from the message (`recipients`,
 *      already opt-out-stripped by the producer) — the consumer never re-reads the raw
 *      `audience_chunks` row, because that row still contains opted-out numbers. It **does**
 *      re-check the live `opt_outs` blacklist so a recipient who opted out after the campaign
 *      was created is dropped at send time (roadmap 11.3).
 *   2. Idempotency/race guard: a non-`PENDING` batch is acked and skipped. A campaign being
 *      cancelled (`CANCELLING`/`CANCELLED`) retires the batch as `CANCELLED` and skips the send.
 *   3. Call the provider once (`POST /3.0/send/bulk` or `/3.0/schedule/bulk`).
 *   4. Apply the retry policy (`200` success / `400`+`401` terminal fail / `429`+`5xx`+network
 *      retry with backoff).
 *   5. Recompute the campaign aggregate and settle it when the last batch finishes.
 *
 * It never loops provider calls (hard rule #3): one message ⇒ at most one provider request.
 */

import { firstRow } from "../db/client.js";
import { loadOptOutSet } from "../services/audience.js";
import {
  sendBulk,
  scheduleBulk,
  type BulkSmsResponse,
  type SendmodeConfig,
  type SendmodeFailureReason,
  type SendmodeResult,
} from "../services/sendmode.js";
import { nowUtcIso } from "../lib/uk-time.js";
import type { DispatchBatchMessage } from "./messages.js";
import { recomputeCampaign } from "./campaign-status.js";

/** The campaign columns the dispatch handler needs (tech.md §4). */
interface CampaignRow {
  id: string;
  name: string;
  sender_id: string;
  message: string;
  mode: string;
  schedule_date: string | null;
  status: string;
}

/** The batch columns the dispatch handler needs. */
interface BatchRow {
  id: string;
  campaign_id: string;
  chunk_index: number;
  status: string;
}

/** Dependencies the handler needs, kept structural so tests can inject fakes (no CF types). */
export interface DispatchDeps {
  db: D1Database;
  /** Sendmode credentials (+ injectable fetch/baseUrl for tests). */
  sendmode: SendmodeConfig;
  /** Injectable clock (ISO 8601 UTC); defaults to the real clock. */
  now?: () => string;
}

/**
 * Handle one `DISPATCH_BATCH` message. Returns the outcome so the caller (`queue()` in
 * `src/index.ts`) decides whether to `ack` or `retry` — the message object is not touched here,
 * which keeps this function trivially unit-testable.
 */
export type DispatchOutcome =
  | { action: "ack"; reason: string }
  | { action: "retry"; delaySeconds: number; reason: string };

/**
 * Run the dispatch flow for one message.
 *
 * `attempts` is `msg.attempts` (1 on first delivery). The retry delay follows the roadmap
 * rule `10 * attempts` seconds, so repeated transient failures back off.
 */
export async function handleDispatch(
  message: DispatchBatchMessage,
  deps: DispatchDeps,
  attempts: number,
): Promise<DispatchOutcome> {
  const now = deps.now ?? nowUtcIso;

  // 1. Load the campaign + batch. A missing row is a terminal data problem (the producer only
  //    enqueues after inserting), so ack rather than retry forever.
  const campaign = await firstRow<CampaignRow>(
    deps.db,
    "SELECT id, name, sender_id, message, mode, schedule_date, status FROM campaigns WHERE id = ?",
    message.campaignId,
  );
  if (!campaign) {
    return { action: "ack", reason: `campaign ${message.campaignId} not found` };
  }

  const batch = await firstRow<BatchRow>(
    deps.db,
    "SELECT id, campaign_id, chunk_index, status FROM campaign_batches WHERE id = ?",
    message.batchId,
  );
  if (!batch) {
    return { action: "ack", reason: `batch ${message.batchId} not found` };
  }

  // 2. Idempotency guard: a batch that already left PENDING must not be sent again (a retry
  //    after a successful send, or a duplicate delivery). Recompute the aggregate anyway so a
  //    previously-failed settle is healed.
  if (batch.status !== "PENDING") {
    await recomputeCampaign(deps.db, campaign.id, now());
    return { action: "ack", reason: `batch already ${batch.status}` };
  }

  // 2b. Cancel race: the operator cancelled while this message was queued. Retire the batch as
  //     CANCELLED (it never reached the provider) and settle the campaign.
  if (campaign.status === "CANCELLING" || campaign.status === "CANCELLED") {
    await deps.db
      .prepare("UPDATE campaign_batches SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
      .bind(now(), batch.id)
      .run();
    await recomputeCampaign(deps.db, campaign.id, now());
    return { action: "ack", reason: "campaign cancelling" };
  }

  // 3. Resolve recipients: inline (test send) or from the pre-chunked audience row.
  const resolved = await resolveRecipients(deps.db, message);

  // 3b. Re-check opt-outs at dispatch time (roadmap 11.3). The producer strips opt-outs at
  //     create time, but for a *scheduled* campaign a recipient may have opted out during the
  //     window before the send. The blacklist is the only live input, so filter the resolved
  //     list against a fresh opt-out set (one small query per batch; the raw `audience_chunks`
  //     row is deliberately never re-read here).
  const optOuts = await loadOptOutSet(deps.db);
  const recipients = resolved.filter((n) => !optOuts.has(n));

  if (recipients.length === 0) {
    // Nothing to send (no recipients, or all opted out since creation): treat as a terminal
    // failure for this batch so the campaign can settle rather than hang on an empty chunk.
    await markFailed(deps.db, batch.id, "no valid recipients for this batch", now());
    await recomputeCampaign(deps.db, campaign.id, now());
    return { action: "ack", reason: "empty recipient list" };
  }

  // Build the outbound call. `message` already contains the appended opt-out suffix (the
  // producer stored the full body). `tags`/`customer_id` follow tech.md Flow C step 3.
  const payload = {
    senderId: campaign.sender_id,
    message: campaign.message,
    mobileNumbers: recipients,
    customerId: batch.id,
    tags: [campaign.name],
  };

  const isScheduled = campaign.mode === "SCHEDULED" && campaign.schedule_date !== null;
  const result: SendmodeResult<BulkSmsResponse> = isScheduled
    ? await scheduleBulk(deps.sendmode, payload, campaign.schedule_date as string)
    : await sendBulk(deps.sendmode, payload);

  // 4. Apply the retry policy.
  if (!result.ok) {
    if (isTransient(result.reason)) {
      // 429 / 5xx / network → retry with backoff (roadmap 7.4). Leave the batch PENDING.
      return { action: "retry", delaySeconds: 10 * Math.max(1, attempts), reason: result.reason };
    }
    // 400 / 401 / invalid 2xx body → non-retryable: mark the batch FAILED and settle.
    await markFailed(deps.db, batch.id, result.message, now());
    await recomputeCampaign(deps.db, campaign.id, now());
    return { action: "ack", reason: `terminal provider error: ${result.reason}` };
  }

  // 4b. HTTP 200 but `is_successful: false` — the provider rejected the bulk call. Treat it as
  //     a terminal batch failure (a retry would fail identically).
  if (!result.data.is_successful) {
    const message = result.data.error_message ?? "provider rejected the batch";
    await markFailed(deps.db, batch.id, message, now());
    await recomputeCampaign(deps.db, campaign.id, now());
    return { action: "ack", reason: "provider rejected batch" };
  }

  // 5. Success: persist the request id + invalid numbers and the terminal batch status.
  await settleBatch(deps.db, batch.id, {
    status: isScheduled ? "SCHEDULED" : "SENT",
    requestId: result.data.request_id,
    invalidNumbers: result.data.invalid_mobile_numbers,
    now: now(),
  });
  await recomputeCampaign(deps.db, campaign.id, now());
  return { action: "ack", reason: isScheduled ? "scheduled" : "sent" };
}

/** Whether a provider failure reason should be retried (vs. marked FAILED terminally). */
export function isTransient(reason: SendmodeFailureReason): boolean {
  return reason === "rate_limited" || reason === "server_error" || reason === "network";
}

/**
 * Resolve the recipient list for a dispatch message. The message always carries `recipients`
 * (the producer strips opt-outs before enqueuing; a test send supplies its single number). The
 * `audience_chunks` fallback exists only for a legacy/abbreviated message that omitted them, so
 * the batch can still send rather than strand — but the primary path is the inline list.
 */
async function resolveRecipients(db: D1Database, message: DispatchBatchMessage): Promise<string[]> {
  if (message.recipients && message.recipients.length > 0) {
    return message.recipients;
  }
  const row = await firstRow<{ mobile_numbers_json: string }>(
    db,
    "SELECT mobile_numbers_json FROM audience_chunks WHERE chunk_index = ?",
    message.chunkIndex,
  );
  if (!row) return [];
  return parseNumbers(row.mobile_numbers_json);
}

/** Parse a chunk's `mobile_numbers_json`, tolerating garbage (never throw in the consumer). */
function parseNumbers(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/** Mark a batch terminally `FAILED` with a safe, human-readable reason (tech.md §9.6). */
async function markFailed(db: D1Database, batchId: string, reason: string, now: string): Promise<void> {
  await db
    .prepare(
      "UPDATE campaign_batches SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ?",
    )
    .bind(truncate(reason), now, batchId)
    .run();
}

/** Persist a successful batch: its provider status, request id, and invalid-number list. */
async function settleBatch(
  db: D1Database,
  batchId: string,
  data: { status: "SENT" | "SCHEDULED"; requestId: string; invalidNumbers: string[]; now: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE campaign_batches
         SET status = ?, sendmode_request_id = ?, invalid_numbers_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(data.status, data.requestId, JSON.stringify(data.invalidNumbers), data.now, batchId)
    .run();
}

/** Keep stored error messages bounded so a verbose provider body cannot bloat the row. */
function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
