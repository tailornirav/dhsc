import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

import { createRequireAuth } from "./lib/auth.js";
import type { Env, AppEnv } from "./env.js";
import {
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  isSameOrigin,
  publicRouteLimiter,
  rateLimit,
} from "./lib/hardening.js";
import { registerBalanceRoutes } from "./routes/balance.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerTestSmsRoutes } from "./routes/test-sms.js";
import { registerOptOutRoutes } from "./routes/opt-outs.js";
import { registerOptOutPageRoutes } from "./routes/opt-out-page.js";
import type { QueueMessage } from "./queue/messages.js";
import { handleDispatch } from "./queue/dispatch.js";
import { handleCancel } from "./queue/cancel.js";
import { reconcileScheduledCampaigns } from "./queue/reconcile.js";

// Re-exported for back-compat: the Phase 5 tests import `type Env` from here.
export type { Env, AppEnv } from "./env.js";

/**
 * Paths under `/api/*` that are **public** (no auth). This is the *only* documented
 * carve-out (tech.md §5, mission.md §6.4): the customer opt-out flow. Everything else under
 * `/api/*` is guarded by `requireAuth`, so a new route is protected by default — it must be
 * explicitly added here to opt out, which makes forgetting the guard impossible.
 *
 * Match is exact-or-prefixed on the path (see `isPublicApiPath`).
 */
export const PUBLIC_API_PATHS: readonly string[] = ["/api/opt-out"];

/** True when `pathname` is one of the public opt-out paths (exact or a sub-path). */
export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Build the Worker's Hono app: global hardening, then the single `/api/*` auth guard with the
 * opt-out carve-out. Exported as a factory so tests can construct a fresh instance and attach
 * probe routes before it is first used (Hono freezes its matcher on first request).
 */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Auth guard bound to this Worker's full bindings (reads `DEV_AUTH_*`, returns 401).
  const requireAuth = createRequireAuth<Env>();
  // Throttle for the public opt-out surface (singleton limiter → counters persist per isolate).
  const publicLimit = rateLimit(publicRouteLimiter);

  // --------------------------------------------------------------------------------------
  // Global hardening — applied to every response/route, authenticated or not.
  // --------------------------------------------------------------------------------------
  app.use("*", secureHeaders(SECURITY_HEADERS));
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES }));

  // --------------------------------------------------------------------------------------
  // API guard — one middleware for the whole `/api/*` group with the opt-out carve-out.
  // First a stateless same-origin backstop on unsafe methods (roadmap 11.2): this covers the
  // whole group, so both the authenticated routes and the public opt-out mutation are checked
  // by the one rule. Public paths then skip auth but are instead rate-limited per client IP.
  // --------------------------------------------------------------------------------------
  app.use("/api/*", async (c, next) => {
    if (!isSameOrigin(c)) {
      return c.json({ error: "cross_origin_blocked" }, 403);
    }
    if (isPublicApiPath(new URL(c.req.url).pathname)) {
      return publicLimit(c, next);
    }
    return requireAuth(c, next);
  });

  // --------------------------------------------------------------------------------------
  // Phase 6 routes — all behind the guard above except the public opt-out carve-out.
  // --------------------------------------------------------------------------------------
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  registerBalanceRoutes(app);
  registerCampaignRoutes(app);
  registerTestSmsRoutes(app);
  registerOptOutRoutes(app);

  // Phase 9.5 — the public opt-out page at `/x` (the target of the SMS `Stop: dhsc.uk/x`
  // suffix). Standalone and outside `/api/*`, so the guard above already ignores it.
  registerOptOutPageRoutes(app);

  return app;
}

const app = createApp();

/**
 * Delay between provider calls within a batch (tech.md §6, "Consumer entrypoint"). Messages are
 * processed **sequentially** with a small pause so a burst of 5 dispatches does not hit the
 * provider all at once (the queue's `max_concurrency: 2` is the hard ceiling; this is the gentle
 * in-batch pacing). Kept tiny so the invocation stays well inside the CPU budget.
 */
const INTER_MESSAGE_DELAY_MS = 200;

/** Sleep helper — `scheduler.wait` is not available on all compat dates, so use a timer. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Queue consumer: route each message by `type`, process them sequentially, and apply the
 * retry/ack policy (roadmap 7.3–7.5).
 *
 * - `DISPATCH_BATCH` → send/schedule one chunk (tech.md Flow C).
 * - `CANCEL_BATCH` → delete one scheduled provider job (tech.md Flow C).
 *
 * The per-message handler decides ack-vs-retry; a transient provider failure returns
 * `{ action: 'retry', delaySeconds }` and we call `msg.retry({ delaySeconds })`, otherwise
 * `msg.ack()`. An **unknown** `type` is acked (a malformed message must not poison the queue
 * and loop until the DLQ). A thrown error is caught and retried with backoff so one bad message
 * cannot drop the whole batch.
 */
export default {
  fetch: app.fetch,
  /**
   * Cron Trigger entrypoint (tech.md Flow D, roadmap 13.3): settle past-due `SCHEDULED`
   * campaigns. Runs every 15 minutes (`wrangler.jsonc` `triggers.crons`) so a scheduled send is
   * recorded even when no operator opens the dashboard. It makes **no** provider call — the
   * reconcile is time-based because Sendmode exposes no status endpoint (mission.md §8.7/§8.12).
   *
   * `event`/`ctx` are unused: the reconcile reads and writes D1 only, with no message plumbing.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await reconcileScheduledCampaigns({ db: env.DB });
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const sendmode = { accessKey: env.SENDMODE_ACCESS_KEY };

    for (let i = 0; i < batch.messages.length; i += 1) {
      const msg = batch.messages[i];
      if (!msg) continue;
      if (i > 0) await delay(INTER_MESSAGE_DELAY_MS);

      try {
        const outcome = await routeMessage(msg.body, env, sendmode, msg.attempts);
        if (outcome.action === "retry") {
          msg.retry({ delaySeconds: outcome.delaySeconds });
        } else {
          msg.ack();
        }
      } catch {
        // A handler bug must not silently drop the send: retry with backoff so it is visible
        // (and eventually lands in the DLQ) rather than being lost.
        const attempt = Math.max(1, msg.attempts);
        msg.retry({ delaySeconds: 10 * attempt });
      }
    }
  },
};

/** Route one message body to its handler and normalize the outcome. */
async function routeMessage(
  body: QueueMessage,
  env: Env,
  sendmode: { accessKey: string },
  attempts: number,
): Promise<{ action: "ack" | "retry"; delaySeconds: number }> {
  switch (body.type) {
    case "DISPATCH_BATCH": {
      const outcome = await handleDispatch(body, { db: env.DB, sendmode }, attempts);
      return outcome.action === "retry"
        ? { action: "retry", delaySeconds: outcome.delaySeconds }
        : { action: "ack", delaySeconds: 0 };
    }
    case "CANCEL_BATCH": {
      const outcome = await handleCancel(body, { db: env.DB, sendmode }, attempts);
      return outcome.action === "retry"
        ? { action: "retry", delaySeconds: outcome.delaySeconds }
        : { action: "ack", delaySeconds: 0 };
    }
    default:
      // Exhaustiveness: `body` is a discriminated union, so `never` here means we handled all
      // known types. Anything else (a malformed payload) is acked to avoid a poison loop.
      return { action: "ack", delaySeconds: 0 };
  }
}

// Re-exported so tests and later phases can reuse a fresh app without the default export.
export { app };
