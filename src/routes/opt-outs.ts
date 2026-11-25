/**
 * Opt-out endpoints.
 *
 * Two families, deliberately separated by **name** so the auth guard's carve-out is exact:
 *   - `/api/opt-outs` (plural) — authenticated management used by the Opt-Outs modal
 *     (roadmap 6.7): list, add, remove.
 *   - `/api/opt-out`  (singular) — the **public** opt-out page (the only unauthenticated
 *     route; `PUBLIC_API_PATHS` in `src/index.ts`). Validated + rate-limited.
 *
 * Both share `src/services/opt-outs.ts`, so a number normalises and de-duplicates identically
 * no matter who submits it.
 */

import type { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { readJsonBody, requiredString } from "../lib/http.js";
import { nowUtcIso } from "../lib/uk-time.js";
import { addOptOut, listOptOuts, removeOptOut } from "../services/opt-outs.js";
import { optOutCount, validRecipientCount } from "../services/audience.js";
import { OPT_OUT_ERROR_HTML, OPT_OUT_RESULT_HTML } from "./opt-out-page.js";

/** Shared validation error for a bad number, keyed for form display. */
function invalidNumber() {
  return {
    error: "validation_failed",
    issues: [{ field: "number", code: "invalid_number", message: "Enter a valid UK mobile number." }],
  };
}

export function registerOptOutRoutes(app: Hono<AppEnv>): void {
  // -------------------------------------------------------------------------------------
  // Authenticated management (guard applies via the /api/* middleware).
  // -------------------------------------------------------------------------------------
  app.get("/api/opt-outs", async (c) => {
    const [optOuts, count, validRecipients] = await Promise.all([
      listOptOuts(c.env.DB),
      optOutCount(c.env.DB),
      validRecipientCount(c.env.DB),
    ]);
    return c.json({
      count,
      validRecipientCount: validRecipients,
      optOuts: optOuts.map((row) => ({ number: row.mobile_number, createdAt: row.created_at })),
    });
  });

  app.post("/api/opt-outs", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return c.json(parsed.body, parsed.status);

    const result = await addOptOut(c.env.DB, requiredString(parsed.value, "number"), nowUtcIso());
    if (result === null) return c.json(invalidNumber(), 400);

    const validRecipients = await validRecipientCount(c.env.DB);
    return c.json(
      { number: result.number, added: result.added, validRecipientCount: validRecipients },
      result.added ? 201 : 200,
    );
  });

  app.delete("/api/opt-outs/:number", async (c) => {
    const removed = await removeOptOut(c.env.DB, c.req.param("number"));
    if (!removed) {
      return c.json({ error: "not_found", message: "That number is not in the opt-out list." }, 404);
    }
    const validRecipients = await validRecipientCount(c.env.DB);
    return c.json({ number: c.req.param("number"), removed: true, validRecipientCount: validRecipients });
  });

  // -------------------------------------------------------------------------------------
  // Public opt-out page — the only unauthenticated route.
  // Accepts JSON (from the SPA) or a plain HTML form post (urlencoded), so the page works
  // even without JavaScript. Rate limiting is applied by the /api/* middleware carve-out.
  // Content-negotiates the response (roadmap 11.1): a plain form post gets an HTML confirmation
  // (or HTML error) page; API/SPA callers keep the JSON contract unchanged.
  // -------------------------------------------------------------------------------------
  app.post("/api/opt-out", async (c) => {
    const wantsHtml = prefersHtml(c.req.raw);

    const number = await readPublicNumber(c.req.raw);
    if (number === null) {
      return wantsHtml ? c.html(OPT_OUT_ERROR_HTML, 400) : c.json(invalidNumber(), 400);
    }

    const result = await addOptOut(c.env.DB, number, nowUtcIso());
    if (result === null) {
      return wantsHtml ? c.html(OPT_OUT_ERROR_HTML, 400) : c.json(invalidNumber(), 400);
    }

    // Neutral message whether or not the number was already present: the customer only needs
    // to know they will not receive further messages, and this avoids revealing membership.
    if (wantsHtml) return c.html(OPT_OUT_RESULT_HTML);
    return c.json({
      ok: true,
      message: "You have been opted out and will not receive further messages.",
    });
  });
}

/**
 * Content negotiation for `POST /api/opt-out` (roadmap 11.1.1).
 *
 * A plain, zero-JS HTML form post (`Content-Type: application/x-www-form-urlencoded`) has no
 * `Accept: application/json`, so it gets the human-facing HTML result. The SPA / API callers send
 * JSON (or an explicit `Accept: application/json`) and keep the JSON contract untouched.
 */
function prefersHtml(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json")) return false;
  const contentType = request.headers.get("content-type") ?? "";
  // A form post is the canonical public case; anything JSON-shaped is an API caller.
  if (contentType.includes("application/json")) return false;
  return true;
}

/**
 * Extract the submitted number from either a JSON body (`{ number }`) or a urlencoded form
 * field named `number`/`phone`. Returns the raw string (validation happens in the service) or
 * `null` when no usable value is present.
 */
async function readPublicNumber(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      const value = body?.number ?? body?.phone;
      return typeof value === "string" ? value : null;
    }
    // Default to form-encoded (a plain HTML form post).
    const form = await request.formData();
    const value = form.get("number") ?? form.get("phone");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
