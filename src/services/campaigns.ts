/**
 * Campaign service — the persistence + orchestration layer behind the Phase 6 campaign
 * endpoints. It implements tech.md §6 Flow A (create) and Flow B (cancel) and the queries
 * behind the list/detail views. It never calls the provider: fan-out goes through the queue
 * (hard rule #3), which is why every function here either reads D1 or writes D1 + enqueues.
 *
 * Status values are exactly the ones in tech.md §4 (no invented values):
 *   campaign: QUEUED | PROCESSING | SENT | SCHEDULED | CANCELLING | CANCELLED | PARTIAL_FAILURE
 *   batch:    PENDING | SENT | SCHEDULED | CANCELLED | FAILED
 */

import { allRows, firstRow } from "../db/client.js";
import { QUEUE_BATCH_LIMIT, type DispatchBatchMessage, type CancelBatchMessage } from "../queue/messages.js";

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

/** A `campaigns` row as stored in D1 (snake_case, matching the schema). */
export interface CampaignRow {
  id: string;
  name: string;
  sender_id: string;
  message: string;
  mode: string;
  schedule_date: string | null;
  status: string;
  total_recipients: number;
  total_batches: number;
  completed_batches: number;
  failed_batches: number;
  invalid_count: number;
  estimated_credits: number;
  is_test: number;
  created_at: string;
  updated_at: string;
}

/** A `campaign_batches` row as stored in D1. */
export interface CampaignBatchRow {
  id: string;
  campaign_id: string;
  chunk_index: number;
  status: string;
  sendmode_request_id: string | null;
  invalid_numbers_json: string | null;
  error_message: string | null;
  updated_at: string;
}

/** A recipient group destined for one queue message / one provider call. */
export interface PlannedBatch {
  id: string;
  chunkIndex: number;
  recipients: string[];
}

/** Everything needed to persist and enqueue a new campaign (Flow A steps 3–4). */
export interface NewCampaign {
  id: string;
  name: string;
  senderId: string;
  /** The exact outbound body, suffix included (`ValidatedCampaign.fullMessage`). */
  message: string;
  mode: "IMMEDIATE" | "SCHEDULED";
  /** ISO 8601 UTC (`Z`) or `null` for immediate sends. */
  scheduleDateUtc: string | null;
  /** Segment count × recipients; what the balance pre-flight compared against. */
  estimatedCredits: number;
  totalRecipients: number;
  isTest: boolean;
  batches: PlannedBatch[];
  /** `created_at`/`updated_at` stamp (injectable for deterministic tests). */
  now: string;
}

// ---------------------------------------------------------------------------------------
// Flow A — create
// ---------------------------------------------------------------------------------------

/**
 * Persist a campaign and its batch rows in **one** `env.DB.batch([...])` call (Flow A step 3,
 * hard rule #4: counts as a single query and each statement binds few parameters).
 *
 * The campaign starts `QUEUED`; every batch starts `PENDING`. The queue consumer flips both
 * as it works. Idempotency is safe because the ids are fresh UUIDs — a duplicate insert
 * cannot happen for a single create request.
 */
export async function insertCampaign(db: D1Database, campaign: NewCampaign): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO campaigns (
           id, name, sender_id, message, mode, schedule_date, status,
           total_recipients, total_batches, completed_batches, failed_batches,
           invalid_count, estimated_credits, is_test, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)`,
      )
      .bind(
        campaign.id,
        campaign.name,
        campaign.senderId,
        campaign.message,
        campaign.mode,
        campaign.scheduleDateUtc,
        "QUEUED",
        campaign.totalRecipients,
        campaign.batches.length,
        campaign.estimatedCredits,
        campaign.isTest ? 1 : 0,
        campaign.now,
        campaign.now,
      ),
  );

  for (const batch of campaign.batches) {
    statements.push(
      db
        .prepare(
          `INSERT INTO campaign_batches (id, campaign_id, chunk_index, status, updated_at)
           VALUES (?, ?, ?, 'PENDING', ?)`,
        )
        .bind(batch.id, campaign.id, batch.chunkIndex, campaign.now),
    );
  }

  await db.batch(statements);
}

// ---------------------------------------------------------------------------------------
// Flow A — create idempotency (roadmap 13.2)
// ---------------------------------------------------------------------------------------

/**
 * Look up a previously stored create result by its client `Idempotency-Key` (roadmap 13.2.1).
 * Returns the stored `202` body string (exactly as first returned) when the key has been seen,
 * or `null` when it is new. A caller with a `null` result proceeds with the normal create flow.
 *
 * No provider call: this is a pure read so the route can short-circuit *before* any spend.
 */
export async function getIdempotentResult(db: D1Database, key: string): Promise<string | null> {
  const row = await firstRow<{ response_json: string }>(
    db,
    "SELECT response_json FROM idempotency_keys WHERE key = ?",
    key,
  );
  return row?.response_json ?? null;
}

/**
 * Persist a create result under its `Idempotency-Key` (roadmap 13.2.2) so a retry of the same
 * submission replays it instead of creating a second campaign (and a second spend).
 *
 * A short standalone `INSERT` keeps the D1 per-invocation budget untouched; the primary key on
 * `key` makes a concurrent duplicate a no-op, so an overlapping retry can never double-write.
 */
export async function saveIdempotentResult(
  db: D1Database,
  key: string,
  campaignId: string,
  responseJson: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, campaign_id, response_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(key, campaignId, responseJson, now)
    .run();
}

// ---------------------------------------------------------------------------------------
// Queue fan-out
// ---------------------------------------------------------------------------------------

/** Split `items` into slices of at most `size` (defaults to the provider/queue cap of 100). */
export function chunkArray<T>(items: T[], size: number = QUEUE_BATCH_LIMIT): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Enqueue one `DISPATCH_BATCH` message per batch, in slices of ≤100 per `sendBatch()` call
 * (Flow A step 4, hard rule #3 — never loop provider calls in a request; the queue fans out).
 * Returns the number of messages handed to the queue.
 *
 * Each message carries the batch's **stripped** `recipients` (opt-outs already removed by
 * `loadAudienceChunks`). This is essential: the consumer must send exactly the numbers the
 * operator's cost estimate covered, and it must **never** re-read the raw `audience_chunks` row —
 * that row still contains opted-out numbers, and the blacklist is only applied at audience
 * computation (tech.md §4 "Opt-outs", mission.md §4.8). Passing the recipients inline keeps the
 * send faithful to the displayed audience without a second, racy blacklist lookup per batch.
 * (~100 E.164 numbers is ~1.5 KB, far inside the queue message limit.)
 */
export async function enqueueDispatch(
  queue: Queue<DispatchBatchMessage>,
  campaignId: string,
  batches: PlannedBatch[],
): Promise<number> {
  let sent = 0;
  for (const slice of chunkArray(batches)) {
    await queue.sendBatch(
      slice.map((batch) => ({
        body: {
          type: "DISPATCH_BATCH",
          campaignId,
          batchId: batch.id,
          chunkIndex: batch.chunkIndex,
          recipients: batch.recipients,
        } satisfies DispatchBatchMessage,
      })),
    );
    sent += slice.length;
  }
  return sent;
}

// ---------------------------------------------------------------------------------------
// Reads — list and detail
// ---------------------------------------------------------------------------------------

/** Which set of campaigns a list request wants. */
export type CampaignFilter = "upcoming" | "history";

/**
 * Parse the `?filter=` query value. Absent ⇒ `"history"` (the default view shows past
 * campaigns). Anything else ⇒ `null` (a `400`, so a typo is loud rather than silently wrong).
 */
export function parseCampaignFilter(value: string | undefined): CampaignFilter | null {
  if (value === undefined || value === "") return "history";
  if (value === "upcoming" || value === "history") return value;
  return null;
}

/**
 * List campaigns by `created_at DESC` (tech.md §5). `upcoming` = scheduled campaigns not yet
 * finished (`SCHEDULED`/`PROCESSING`/`CANCELLING`); `history` = everything else (terminal
 * states plus `QUEUED` immediate sends). We filter with a `WHERE` on the status set so the
 * tabs match the prototype's "Queued" vs "History" split.
 */
export async function listCampaigns(
  db: D1Database,
  filter: CampaignFilter,
): Promise<CampaignRow[]> {
  if (filter === "upcoming") {
    return allRows<CampaignRow>(
      db,
      `SELECT * FROM campaigns
       WHERE status IN ('SCHEDULED', 'PROCESSING', 'CANCELLING')
       ORDER BY created_at DESC`,
    );
  }
  // history: everything that is not an in-flight scheduled job.
  return allRows<CampaignRow>(
    db,
    `SELECT * FROM campaigns
     WHERE status NOT IN ('SCHEDULED', 'PROCESSING', 'CANCELLING')
     ORDER BY created_at DESC`,
  );
}

/** Load one campaign by id, or `null` when it does not exist. */
export function getCampaign(db: D1Database, id: string): Promise<CampaignRow | null> {
  return firstRow<CampaignRow>(db, "SELECT * FROM campaigns WHERE id = ?", id);
}

/** Load a campaign's batches, oldest chunk first. */
export function getCampaignBatches(db: D1Database, campaignId: string): Promise<CampaignBatchRow[]> {
  return allRows<CampaignBatchRow>(
    db,
    "SELECT * FROM campaign_batches WHERE campaign_id = ? ORDER BY chunk_index ASC",
    campaignId,
  );
}

// ---------------------------------------------------------------------------------------
// Flow B — cancel
// ---------------------------------------------------------------------------------------

/** Result of attempting to begin a cancellation. */
export type CancelStart =
  | { ok: true; enqueued: number }
  | { ok: false; status: 409 | 404; message: string };

/**
 * Begin cancelling a campaign (tech.md Flow B steps 1–4).
 *
 * Only a campaign that is `QUEUED` (immediate, still untouched) or `SCHEDULED` (future) can
 * be cancelled. Steps:
 *   1. Guard the current status; reject anything already terminal or already cancelling.
 *   2. Set `campaigns.status = 'CANCELLING'`.
 *   3. Mark every still-`PENDING` batch `CANCELLED` — it never reached the provider, so no
 *      provider call is needed for it.
 *   4. Look up `SCHEDULED` batches that carry a `sendmode_request_id` and enqueue a
 *      `CANCEL_BATCH` per batch (in slices of ≤100) for the consumer to `DELETE`.
 *
 * Returns the number of cancel jobs enqueued. The UI polls `GET /api/campaigns/:id` until the
 * status settles to `CANCELLED` (Phase 7 flips it once provider deletes finish).
 */
export async function beginCancellation(
  db: D1Database,
  queue: Queue<CancelBatchMessage>,
  campaign: CampaignRow,
  now: string,
): Promise<CancelStart> {
  if (campaign.status !== "QUEUED" && campaign.status !== "SCHEDULED") {
    return {
      ok: false,
      status: 409,
      message: `Campaign cannot be cancelled from status ${campaign.status}.`,
    };
  }

  // 2 + 3: flip the campaign and retire the not-yet-sent batches in one batch write.
  await db.batch([
    db
      .prepare("UPDATE campaigns SET status = 'CANCELLING', updated_at = ? WHERE id = ?")
      .bind(now, campaign.id),
    db
      .prepare(
        "UPDATE campaign_batches SET status = 'CANCELLED', updated_at = ? WHERE campaign_id = ? AND status = 'PENDING'",
      )
      .bind(now, campaign.id),
  ]);

  // 4: enqueue a provider-cancel job per scheduled batch that has a request id.
  const scheduled = await allRows<{ id: string; sendmode_request_id: string }>(
    db,
    `SELECT id, sendmode_request_id FROM campaign_batches
     WHERE campaign_id = ? AND status = 'SCHEDULED' AND sendmode_request_id IS NOT NULL`,
    campaign.id,
  );

  let enqueued = 0;
  for (const slice of chunkArray(scheduled)) {
    await queue.sendBatch(
      slice.map((row) => ({
        body: {
          type: "CANCEL_BATCH",
          campaignId: campaign.id,
          batchId: row.id,
          requestId: row.sendmode_request_id,
        } satisfies CancelBatchMessage,
      })),
    );
    enqueued += slice.length;
  }

  // If there was nothing to cancel at the provider (e.g. an immediate campaign whose batches
  // were all still PENDING), mark it terminally cancelled now rather than waiting on an empty
  // queue.
  if (enqueued === 0) {
    await db
      .prepare("UPDATE campaigns SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
      .bind(now, campaign.id)
      .run();
  }

  return { ok: true, enqueued };
}
