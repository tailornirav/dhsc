/**
 * `POST /api/test-sms` — send one unscheduled SMS to a single UK number (roadmap 6.6).
 *
 * Used by the "Send Test SMS" modal so the operator can verify copy on a real handset before
 * a blast. The number is validated/normalised like any audience number, the message must fit
 * a single segment (the same rule as a campaign), and the send is **recorded in History**
 * (`is_test = 1`) — see `src/services/test-sms.ts`.
 *
 * Runs through the queue like everything else (hard rule #3), so the same retry/idempotency
 * path applies; it is *not* blocked by balance (a single credit) but we still surface the
 * provider's decision.
 */

import type { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { readJsonBody, requiredString } from "../lib/http.js";
import { normalizeUkMobile, validateCampaign } from "../lib/validate.js";
import { nowUtcIso } from "../lib/uk-time.js";
import { createTestSend } from "../services/test-sms.js";
import type { DispatchBatchMessage } from "../queue/messages.js";

export function registerTestSmsRoutes(app: Hono<AppEnv>): void {
  app.post("/api/test-sms", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    const body = parsed.value;

    // Validate the recipient number up front.
    const number = normalizeUkMobile(requiredString(body, "to"));
    if (number === null) {
      return c.json(
        { error: "validation_failed", issues: [{ field: "to", code: "invalid_number", message: "Enter a valid UK mobile number." }] },
        400,
      );
    }

    // Reuse the campaign validator for the sender/message rules (single-segment cap, no <>).
    const validated = validateCampaign({
      name: "Test SMS",
      senderId: requiredString(body, "senderId"),
      message: requiredString(body, "message"),
      mode: "IMMEDIATE",
    });
    if (!validated.ok) return c.json({ error: "validation_failed", issues: validated.issues }, 400);

    const { campaignId, batchId, fullMessage } = await createTestSend(
      c.env.DB,
      c.env.SMS_QUEUE as Queue<DispatchBatchMessage>,
      {
        recipient: number,
        senderId: validated.value.senderId,
        message: validated.value.message,
        now: nowUtcIso(),
      },
    );

    return c.json(
      {
        id: campaignId,
        batchId,
        status: "QUEUED",
        recipient: number,
        message: fullMessage,
        estimatedCredits: 1,
      },
      202,
    );
  });
}
