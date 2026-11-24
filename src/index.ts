import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

import { createRequireAuth } from "./lib/auth.js";
import type { Env, AppEnv } from "./env.js";
import {
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  publicRouteLimiter,
  rateLimit,
} from "./lib/hardening.js";
import { registerBalanceRoutes } from "./routes/balance.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerTestSmsRoutes } from "./routes/test-sms.js";
import { registerOptOutRoutes } from "./routes/opt-outs.js";
import type { QueueMessage } from "./queue/messages.js";

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
  // Public paths skip auth but are instead rate-limited per client IP.
  // --------------------------------------------------------------------------------------
  app.use("/api/*", async (c, next) => {
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

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(_batch: MessageBatch<QueueMessage>, _env: Env): Promise<void> {
    // No-op consumer for now; routing by message `type` lands in Phase 7.
  },
};

// Re-exported so tests and later phases can reuse a fresh app without the default export.
export { app };
