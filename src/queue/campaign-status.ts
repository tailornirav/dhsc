/**
 * Campaign status recomputation — the shared "is this campaign finished, and how did it
 * end?" step of the queue consumer (tech.md Flow C steps 5 & 4, roadmap 7.5).
 *
 * The consumer owns every batch transition; after each batch settles it asks this module to
 * derive the campaign's aggregate status from the batch rows. Centralising it means the
 * `DISPATCH_BATCH` and `CANCEL_BATCH` paths can never disagree about when a campaign is done.
 *
 * We recompute from the **batch rows** rather than mutating counters optimistically: a queue
 * message may be retried or delivered out of order (hard rule #11), so the D1 batch state is
 * the only trustworthy source. The campaign's `completed_batches`/`failed_batches`/`invalid_count`
 * are derived in the same pass so the detail view stays accurate without a second query.
 *
 * Status values are exactly tech.md §4 (no invented values):
 *   campaign: QUEUED | PROCESSING | SENT | SCHEDULED | CANCELLING | CANCELLED | PARTIAL_FAILURE
 *   batch:    PENDING | SENT | SCHEDULED | CANCELLED | FAILED
 */

import { allRows } from "../db/client.js";

/** One batch's status + the invalid-number count the campaign aggregate needs. */
interface BatchTally {
  status: string;
  invalid_count: number;
}

/** The derived campaign aggregate: the numbers to persist plus the terminal status (if any). */
export interface CampaignTally {
  /** Count of batches that reached a "sent to the provider" terminal state. */
  completed: number;
  /** Count of batches that failed terminally. */
  failed: number;
  /** Count of batches cancelled (mid-flight cancel or retired PENDING). */
  cancelled: number;
  /** Total invalid numbers the provider rejected across all batches. */
  invalid: number;
  /** Batches still `PENDING` — if zero, the campaign can settle. */
  pending: number;
  /** Batches still `SCHEDULED` at the provider (counts toward a scheduled campaign). */
  scheduled: number;
  /**
   * The campaign status to persist, or `null` when the campaign is not yet finished (some
   * batches are still `PENDING`) and its current status should be left alone.
   */
  status: "SENT" | "SCHEDULED" | "PARTIAL_FAILURE" | "CANCELLED" | null;
}

/**
 * Derive the campaign aggregate from its batch rows.
 *
 * Terminal rules (tech.md Flow C):
 *   - Any batch still `PENDING` ⇒ `status: null` (not finished; keep waiting).
 *   - Any batch still `SCHEDULED` at the provider ⇒ `status: null` too: a live provider job must
 *     not be summarised as `SENT`, and a `CANCELLING` campaign whose `DELETE` has not landed yet
 *     must not report `CANCELLED` while the job can still fire (tech.md Flow C `CANCEL_BATCH`
 *     step 4: cancel settles only when **zero** `SCHEDULED`/`PENDING` remain).
 *   - Otherwise, if **any** batch was `CANCELLED` ⇒ `CANCELLED` (cancellation is sticky once no
 *     provider job remains).
 *   - Else, if any batch `FAILED` ⇒ `PARTIAL_FAILURE`.
 *   - Else (all `SENT`) ⇒ `SENT`.
 */
export function tallyBatches(rows: BatchTally[]): CampaignTally {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let invalid = 0;
  let pending = 0;
  let scheduled = 0;

  for (const row of rows) {
    invalid += Number(row.invalid_count ?? 0);
    switch (row.status) {
      case "SENT":
        completed += 1;
        break;
      case "SCHEDULED":
        // A scheduled batch also counts as "completed" for progress display (it reached the
        // provider) but is tracked separately so we can pick the SCHEDULED terminal status.
        completed += 1;
        scheduled += 1;
        break;
      case "FAILED":
        failed += 1;
        break;
      case "CANCELLED":
        cancelled += 1;
        break;
      case "PENDING":
        pending += 1;
        break;
      default:
        // Unknown statuses are treated as still-in-flight rather than silently succeeding.
        pending += 1;
        break;
    }
  }

  let status: CampaignTally["status"];
  if (pending > 0) {
    // Still work to do.
    status = null;
  } else if (scheduled > 0) {
    // Every batch has settled, but `scheduled` batches mean live provider jobs. An immediate
    // (all-`SENT`) campaign never reaches here. For a scheduled campaign we settle to
    // `SCHEDULED`; for a cancelling one, a still-live job keeps it in flight until the
    // `CANCEL_BATCH` retires it (tech.md Flow C `CANCEL_BATCH` step 4).
    status = cancelled > 0 ? null : "SCHEDULED";
  } else if (cancelled > 0) {
    status = "CANCELLED";
  } else if (failed > 0) {
    status = "PARTIAL_FAILURE";
  } else {
    status = "SENT";
  }

  return { completed, failed, cancelled, invalid, pending, scheduled, status };
}

/**
 * Recompute the campaign aggregate from D1 and persist it in **one** statement. Returns the
 * tally (including the terminal `status`, or `null` when still in flight). Always updates the
 * denormalised counters; only writes a new `status`/`updated_at` when the campaign has settled
 * (so a mid-flight `QUEUED`/`PROCESSING`/`CANCELLING` campaign is not clobbered prematurely).
 *
 * `now` is injectable for deterministic tests.
 */
export async function recomputeCampaign(
  db: D1Database,
  campaignId: string,
  now: string,
): Promise<CampaignTally> {
  const rows = await allRows<{ status: string; invalid_numbers_json: string | null }>(
    db,
    "SELECT status, invalid_numbers_json FROM campaign_batches WHERE campaign_id = ?",
    campaignId,
  );

  const tally = tallyBatches(
    rows.map((row) => ({
      status: row.status,
      invalid_count: countInvalid(row.invalid_numbers_json),
    })),
  );

  if (tally.status === null) {
    // Still in flight: keep the counters fresh but leave the status to the current value.
    await db
      .prepare(
        `UPDATE campaigns
           SET completed_batches = ?, failed_batches = ?, invalid_count = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(tally.completed, tally.failed, tally.invalid, now, campaignId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE campaigns
           SET status = ?, completed_batches = ?, failed_batches = ?, invalid_count = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(tally.status, tally.completed, tally.failed, tally.invalid, now, campaignId)
      .run();
  }

  return tally;
}

/** Count the entries in a batch's `invalid_numbers_json` array (0 on `null`/garbage). */
function countInvalid(json: string | null): number {
  if (!json) return 0;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
