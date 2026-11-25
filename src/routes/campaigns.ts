/**
 * Campaign endpoints — create, list, detail, and cancel (tech.md §5, §6; roadmap 6.2–6.5).
 *
 * This module is thin: it validates input, calls the `campaigns`/`audience` services, and
 * shapes HTTP responses. The queue fan-out happens inside the service, so no provider call is
 * ever made in a request loop (hard rule #3).
 */

import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { optionalString, readJsonBody, requiredString } from "../lib/http.js";
import {
  campaignCredits,
  parseManualRecipients,
  validateCampaign,
  type CampaignInput,
  type ValidationIssue,
} from "../lib/validate.js";
import { nowUtcIso } from "../lib/uk-time.js";
import { getBalance } from "../services/sendmode.js";
import { loadAudienceChunks, loadOptOutSet, type AudienceChunk } from "../services/audience.js";
import {
  beginCancellation,
  chunkArray,
  getCampaign,
  getCampaignBatches,
  getIdempotentResult,
  insertCampaign,
  listCampaigns,
  parseCampaignFilter,
  enqueueDispatch,
  saveIdempotentResult,
  type CampaignBatchRow,
  type CampaignRow,
  type NewCampaign,
  type PlannedBatch,
} from "../services/campaigns.js";

/** Shape the create request expects from the client (prototype.md §5.1). */
function toCampaignInput(body: Record<string, unknown>): CampaignInput {
  const mode = requiredString(body, "mode");
  return {
    name: requiredString(body, "name"),
    senderId: requiredString(body, "senderId"),
    message: requiredString(body, "message"),
    mode: mode === "SCHEDULED" ? "SCHEDULED" : "IMMEDIATE",
    scheduleLocal: optionalString(body, "scheduleLocal"),
  };
}

/** A `campaigns` row as the API returns it (camelCase, ISO timestamps). */
function serializeCampaign(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    senderId: row.sender_id,
    message: row.message,
    mode: row.mode,
    scheduleDate: row.schedule_date,
    status: row.status,
    totalRecipients: row.total_recipients,
    totalBatches: row.total_batches,
    completedBatches: row.completed_batches,
    failedBatches: row.failed_batches,
    invalidCount: row.invalid_count,
    estimatedCredits: row.estimated_credits,
    isTest: row.is_test === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A per-batch progress/error summary for the detail view (roadmap 6.4). */
function serializeBatch(row: CampaignBatchRow) {
  return {
    id: row.id,
    chunkIndex: row.chunk_index,
    status: row.status,
    requestId: row.sendmode_request_id,
    invalidNumbers: parseJsonArray(row.invalid_numbers_json),
    error: row.error_message,
  };
}

/** Parse a nullable JSON array column, tolerating `null`/garbage. */
function parseJsonArray(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** `400` response body for validation issues, keyed by field for easy form display. */
function issuesBody(issues: ValidationIssue[]) {
  return { error: "validation_failed", issues };
}

export function registerCampaignRoutes(app: Hono<AppEnv>): void {
  // -------------------------------------------------------------------------------------
  // 6.2 — POST /api/campaigns : create + enqueue (Flow A)
  // -------------------------------------------------------------------------------------
  app.post("/api/campaigns", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return c.json(parsed.body, parsed.status);

    // Flow A step 0 (roadmap 13.2.1): replay a previously stored result for a repeated
    // `Idempotency-Key` *before* any balance check, write, or enqueue — a retry must never
    // create a second campaign or a second spend. A create with no key is unchanged.
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || undefined;
    if (idempotencyKey) {
      const stored = await getIdempotentResult(c.env.DB, idempotencyKey);
      if (stored !== null) {
        // The stored body is the verbatim original 202 payload; return it at the same status.
        return c.body(stored, 202, { "Content-Type": "application/json" });
      }
    }

    const validated = validateCampaign(toCampaignInput(parsed.value));
    if (!validated.ok) return c.json(issuesBody(validated.issues), 400);
    const value = validated.value;

    // Build the exact audience we will send to: every chunk minus opt-outs. When the operator
    // pasted a manual `recipients` list (roadmap 12.1) that list is the audience source instead;
    // every downstream step stays byte-identical.
    const optOuts = await loadOptOutSet(c.env.DB);

    let chunks: AudienceChunk[];
    const manual = optionalString(parsed.value, "recipients")?.trim();
    if (manual) {
      const { numbers, invalid } = parseManualRecipients(manual);
      if (invalid.length > 0) {
        // Refuse the whole request on any bad entry — never silently drop (roadmap 12.1.2).
        return c.json(issuesBody(invalid.map((entry): ValidationIssue => ({
          field: "recipients",
          code: "invalid_number",
          message: `“${entry}” is not a valid UK mobile.`,
        }))), 400);
      }
      const stripped = numbers.filter((n) => !optOuts.has(n));
      chunks = chunkArray(stripped).map((recipients, chunkIndex) => ({ chunkIndex, recipients }));
    } else {
      chunks = await loadAudienceChunks(c.env.DB, optOuts);
    }

    const totalRecipients = chunks.reduce((sum, chunk) => sum + chunk.recipients.length, 0);

    if (totalRecipients === 0) {
      return c.json({ error: "empty_audience", message: "No valid recipients available." }, 400);
    }

    // Pre-flight cost + balance (Flow A step 2): block the send if it cannot be afforded.
    const credits = campaignCredits(value, totalRecipients);
    const balanceResult = await getBalance({ accessKey: c.env.SENDMODE_ACCESS_KEY });
    if (!balanceResult.ok) {
      return c.json(
        { error: "provider_error", reason: balanceResult.reason, message: balanceResult.message },
        502,
      );
    }
    if (balanceResult.data.balance < credits) {
      return c.json(
        {
          error: "insufficient_balance",
          message: `This campaign needs ${credits} credits but only ${balanceResult.data.balance} are available.`,
          required: credits,
          available: balanceResult.data.balance,
        },
        400,
      );
    }

    // Fresh UUIDs per batch; the campaign row + all batch rows go in one batch write.
    const now = nowUtcIso();
    const batches: PlannedBatch[] = chunks.map((chunk) => ({
      id: crypto.randomUUID(),
      chunkIndex: chunk.chunkIndex,
      recipients: chunk.recipients,
    }));

    const campaign: NewCampaign = {
      id: crypto.randomUUID(),
      name: value.name,
      senderId: value.senderId,
      message: value.fullMessage,
      mode: value.mode,
      scheduleDateUtc: value.scheduleDateUtc,
      estimatedCredits: credits,
      totalRecipients,
      isTest: false,
      batches,
      now,
    };

    await insertCampaign(c.env.DB, campaign);

    // Flow A step 4: slice into ≤100-message sendBatch calls (two calls for 81 chunks).
    try {
      await enqueueDispatch(c.env.SMS_QUEUE as Queue, campaign.id, batches);
    } catch (error) {
      // The rows exist but nothing is queued; surface a 500 so the operator retries rather
      // than believing a stuck campaign was sent. (Rows are harmless: status stays QUEUED and
      // no batch ever leaves PENDING.)
      const message = error instanceof Error ? error.message : "unknown queue error";
      return c.json({ error: "enqueue_failed", message }, 500);
    }

    // Flow A step 5: build the response body once, so the same bytes can be stored under the
    // key (when one was supplied) for replay — a retry must return an identical body.
    const responseBody = {
      id: campaign.id,
      status: "QUEUED",
      totalRecipients,
      totalBatches: batches.length,
      estimatedCredits: credits,
    };

    if (idempotencyKey) {
      // Persist after the campaign rows + enqueue succeed, so we never memoise a partial create.
      await saveIdempotentResult(
        c.env.DB,
        idempotencyKey,
        campaign.id,
        JSON.stringify(responseBody),
        now,
      );
    }

    return c.json(responseBody, 202);
  });

  // -------------------------------------------------------------------------------------
  // 6.3 — GET /api/campaigns : list by filter, newest first
  // -------------------------------------------------------------------------------------
  app.get("/api/campaigns", async (c) => {
    const filter = parseCampaignFilter(c.req.query("filter"));
    if (filter === null) {
      return c.json(
        { error: "bad_request", message: "filter must be 'upcoming' or 'history'." },
        400,
      );
    }
    const rows = await listCampaigns(c.env.DB, filter);
    return c.json({ filter, campaigns: rows.map(serializeCampaign) });
  });

  // -------------------------------------------------------------------------------------
  // 6.4 — GET /api/campaigns/:id : live progress + invalid count + per-batch errors
  // -------------------------------------------------------------------------------------
  app.get("/api/campaigns/:id", async (c) => {
    const id = c.req.param("id");
    const campaign = await getCampaign(c.env.DB, id);
    if (!campaign) return c.json({ error: "not_found", message: "Campaign not found." }, 404);

    const batches = await getCampaignBatches(c.env.DB, id);
    return c.json({
      campaign: serializeCampaign(campaign),
      batches: batches.map(serializeBatch),
    });
  });

  // -------------------------------------------------------------------------------------
  // 6.5 — POST /api/campaigns/:id/cancel : mark CANCELLING + enqueue cancels (Flow B)
  // -------------------------------------------------------------------------------------
  app.post("/api/campaigns/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const campaign = await getCampaign(c.env.DB, id);
    if (!campaign) return c.json({ error: "not_found", message: "Campaign not found." }, 404);

    const result = await beginCancellation(
      c.env.DB,
      c.env.SMS_QUEUE as Queue,
      campaign,
      nowUtcIso(),
    );
    if (!result.ok) {
      return c.json({ error: "conflict", message: result.message }, result.status);
    }

    return c.json(
      { id: campaign.id, status: "CANCELLING", enqueued: result.enqueued },
      202,
    );
  });
}
