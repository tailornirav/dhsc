/**
 * `GET /api/balance` — credit health for the dashboard KPIs (tech.md §5, roadmap 6.1).
 *
 * Proxies the provider's `GET /3.0/balance` and pairs it with the current **valid audience
 * size** (`seeded total − opt-outs`) so the UI can render "net available credits" against a
 * real recipient count in one round trip.
 *
 * Provider failures are surfaced with a non-2xx and a machine-readable `error` so the header
 * "Sync Balance" button can show a toast rather than silently zeroing the number.
 */

import type { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { getBalance } from "../services/sendmode.js";
import { validRecipientCount } from "../services/audience.js";

export function registerBalanceRoutes(app: Hono<AppEnv>): void {
  app.get("/api/balance", async (c) => {
    const [balanceResult, audienceCount] = await Promise.all([
      getBalance({ accessKey: c.env.SENDMODE_ACCESS_KEY }),
      validRecipientCount(c.env.DB),
    ]);

    if (!balanceResult.ok) {
      // 502: we are the gateway to the provider; map its failure outward without leaking
      // internals (tech.md §9.6).
      return c.json(
        {
          error: "provider_error",
          reason: balanceResult.reason,
          message: balanceResult.message,
        },
        502,
      );
    }

    return c.json({
      balance: balanceResult.data.balance,
      audience_count: audienceCount,
    });
  });
}
