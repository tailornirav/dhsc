/**
 * Scheduled-send reconcile — the Cron `scheduled()` flow (tech.md Flow D, roadmap 13.3).
 *
 * Sendmode exposes **no** endpoint to query a scheduled/sent request's status (`docs/sms-api.md`
 * — only balance/send/schedule/cancel exist) and delivery webhooks stay **deferred**
 * (mission.md §8.7). So a scheduled campaign's outcome is inferred **by time, not by delivery
 * receipt**: a campaign parked at `SCHEDULED` whose `schedule_date` has elapsed is settled from
 * its batch rows — "sent" means **"accepted by the provider and the window has elapsed."** This
 * closes the gap where such a row was previously never updated at all (it sat at `SCHEDULED`
 * forever), which made the Queued/History views dishonest (mission.md §8.12).
 *
 * It is driven by a native **Cron Trigger** (`wrangler.jsonc` `triggers.crons`) rather than a
 * lazy-on-read check, so it happens even when nobody opens the dashboard.
 *
 * This module makes **no** provider call and spends nothing — it only writes D1.
 *
 * Status values are exactly tech.md §4 (no invented values):
 *   campaign: QUEUED | PROCESSING | SENT | SCHEDULED | CANCELLING | CANCELLED | PARTIAL_FAILURE
 *   batch:    PENDING | SENT | SCHEDULED | CANCELLED | FAILED
 */

import { allRows } from "../db/client.js";
import { nowUtcIso } from "../lib/uk-time.js";
import { recomputeCampaign } from "./campaign-status.js";

/** Structural deps so the reconcile is unit-testable without a Worker runtime. */
export interface ReconcileDeps {
  db: D1Database;
  /** Injectable clock (ISO 8601 UTC); defaults to the real clock. */
  now?: () => string;
}

/** Summary of one reconcile run (for logging/tests). */
export interface ReconcileResult {
  /** How many past-due `SCHEDULED` campaigns were selected for settling. */
  examined: number;
}

/**
 * Settle every `SCHEDULED` campaign whose `schedule_date` is in the past (tech.md Flow D).
 *
 * 1. Select the candidate ids with one predicate — `status = 'SCHEDULED' AND schedule_date < now`
 *    (`docs/tech.md` Flow D step 1). `schedule_date` is an ISO 8601 UTC string, so a lexicographic
 *    `<` comparison is the correct chronological order (same as every other timestamp here).
 * 2. For each, run the **same** `recomputeCampaign`/`tallyBatches` path Flow C uses, so the
 *    aggregate can never disagree: all batches `SCHEDULED`/`SENT` → `SENT`; any `FAILED` →
 *    `PARTIAL_FAILURE`.
 *
 * **Idempotent by construction** (Flow D step 3): settling flips the row out of `SCHEDULED`, so
 * the predicate drops it and a duplicate/overlapping Cron run is a no-op. A campaign cancelled
 * before its window is `CANCELLING`/`CANCELLED`, so it never enters the set and can never be
 * resurrected.
 *
 * The clock is injectable (same `now?: () => string` pattern as the queue handlers) so the
 * reconcile is deterministically testable.
 */
export async function reconcileScheduledCampaigns(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = deps.now ?? nowUtcIso;
  const stamp = now();

  const due = await allRows<{ id: string }>(
    deps.db,
    "SELECT id FROM campaigns WHERE status = 'SCHEDULED' AND schedule_date < ?",
    stamp,
  );

  for (const row of due) {
    await recomputeCampaign(deps.db, row.id, stamp, { settleElapsed: true });
  }

  return { examined: due.length };
}
