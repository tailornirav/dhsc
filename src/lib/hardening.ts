/**
 * Baseline request hardening for the Worker (tech.md §9, mission.md §6.4, roadmap 5.3):
 * security headers on every response, a request-body size cap, and a simple in-memory
 * IP rate limiter for the public (unauthenticated) opt-out route.
 *
 * Scope notes:
 *   - **Headers + body limit** come from Hono's built-ins (`secureHeaders`, `bodyLimit`) —
 *     already a project dependency, so no new packages (hard rule #1: Cloudflare only, $0).
 *   - **Rate limiting is best-effort.** Cloudflare Workers isolates are ephemeral and there
 *     are many of them, so an in-memory counter is per-isolate, not global. That is exactly
 *     what the roadmap asks for ("simple in-memory/IP rate limiting"); it blunts casual
 *     abuse/retry storms on the public route. If real abuse appears, replace the store with
 *     a Cloudflare-native limiter (e.g. the Rate Limiting binding) without changing callers.
 */

import type { Context, MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------------------
// Security headers (CSP + the usual suspects)
// ---------------------------------------------------------------------------------------

/**
 * Response hardening applied to **every** response. The CSP is tight (the app is a
 * same-origin dashboard talking only to itself): `default-src 'self'`, no framing, no
 * inline scripts/styles beyond what the SPA build emits via its own assets.
 *
 * We set `frame-ancestors 'none'` (no clickjacking) and keep `connect-src 'self'` so the
 * SPA can call `/api/*` on the same origin.
 */
export const SECURITY_HEADERS = {
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    // The Vite build emits hashed JS/CSS as separate same-origin files. `'unsafe-inline'`
    // is limited to styles (Tailwind may inject a style tag); scripts stay 'self' only.
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
  },
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "strict-origin-when-cross-origin",
  crossOriginOpenerPolicy: "same-origin",
  originAgentCluster: true,
};

/** Maximum accepted request body (bytes). Campaigns are small JSON; 64 KiB is generous. */
export const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------
// In-memory fixed-window rate limiter
// ---------------------------------------------------------------------------------------

/** A per-key counter for the current window. */
interface RateBucket {
  count: number;
  /** Epoch ms at which this window resets. */
  resetAt: number;
}

/** Tunable shape for `createRateLimiter`. */
export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests permitted per key within a window. */
  max: number;
  /** Bucket store; defaults to a fresh `Map` (per isolate). Injectable for tests. */
  store?: Map<string, RateBucket>;
  /** Clock (epoch ms); injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** The public shape of a rate limiter: a check plus its backing store (for tests). */
export interface RateLimiter {
  /** Record one request for `key`; returns whether it is allowed and when the window resets. */
  check(key: string): { allowed: boolean; remaining: number; resetAt: number };
  /** The bucket store (exposed so tests can inspect/clear it). */
  store: Map<string, RateBucket>;
  /** Configured per-window maximum (for `RateLimit-Limit` headers). */
  max: number;
  /** Configured window length in milliseconds (for `RateLimit-Reset` headers). */
  windowMs: number;
}

/**
 * Create a fixed-window in-memory rate limiter. Each key gets a counter that resets when
 * its window elapses. Expired buckets are pruned opportunistically during `check` so the
 * map cannot grow without bound in a long-lived isolate.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const store = options.store ?? new Map<string, RateBucket>();
  const now = options.now ?? Date.now;

  return {
    store,
    max: options.max,
    windowMs: options.windowMs,
    check(key: string) {
      const t = now();
      const existing = store.get(key);

      if (!existing || t >= existing.resetAt) {
        const resetAt = t + options.windowMs;
        const bucket: RateBucket = { count: 1, resetAt };
        store.set(key, bucket);
        // Opportunistic prune: drop a handful of expired buckets on each fresh window.
        pruneExpired(store, t);
        return { allowed: true, remaining: options.max - 1, resetAt };
      }

      if (existing.count >= options.max) {
        return { allowed: false, remaining: 0, resetAt: existing.resetAt };
      }

      existing.count += 1;
      return { allowed: true, remaining: options.max - existing.count, resetAt: existing.resetAt };
    },
  };
}

/** Remove up to 32 expired buckets (`max` keys) to keep the store from growing unbounded. */
function pruneExpired(store: Map<string, RateBucket>, nowMs: number): void {
  let budget = 32;
  for (const [key, bucket] of store) {
    if (budget-- <= 0) break;
    if (nowMs >= bucket.resetAt) store.delete(key);
  }
}

/**
 * Default limiter for the public opt-out route: 10 requests per minute per client IP. The
 * same limiter instance is reused across requests within an isolate so counters persist.
 */
export const publicRouteLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

/**
 * Best-effort client IP for rate-limit keying. Cloudflare sets `CF-Connecting-IP`; fall back
 * to `X-Forwarded-For`'s first hop, then a constant so an unknown IP shares one bucket
 * (fail-closed-ish rather than bypassing the limit entirely).
 */
export function clientIp(headers: Headers): string {
  const cf = headers.get("CF-Connecting-IP");
  if (cf && cf.trim() !== "") return cf.trim();
  const xff = headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * Hono middleware enforcing the given limiter. On exceed it returns `429` with `Retry-After`
 * (seconds) and `RateLimit-*` headers so well-behaved clients back off.
 */
export function rateLimit(
  limiter: RateLimiter = publicRouteLimiter,
  keyOf: (c: Context) => string = (c) => clientIp(c.req.raw.headers),
): MiddlewareHandler {
  return async (c, next) => {
    const result = limiter.check(keyOf(c));
    c.header("RateLimit-Limit", String(limiter.max));
    c.header("RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: "rate_limited", message: "Too many requests. Please try again shortly." },
        429,
      );
    }
    await next();
  };
}
