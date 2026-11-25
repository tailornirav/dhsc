/**
 * Phase 5 verification — Auth & middleware.
 *
 *   npm test        # runs everything under test/
 *
 * Coverage matches roadmap Phase 5 "Verify":
 *   - unauthenticated `GET /api/balance` → `401`;
 *   - with a Cloudflare Access identity (or the dev bypass) → passes through;
 *   - no `/api/*` route is reachable anonymously (the guard covers the whole group);
 *   - the public opt-out carve-out is reachable without auth but is rate-limited;
 *   - security headers + the request-size limit are applied.
 *
 * We exercise the real Hono app (`app.request(path, init, env)`) so the middleware is proven,
 * not just the pure helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";

import {
  CF_ACCESS_EMAIL_HEADER,
  CF_ACCESS_JWT_HEADER,
  DEV_IDENTITY,
  isDevBypassEnabled,
  resolveAccessIdentity,
} from "../src/lib/auth.js";
import {
  MAX_BODY_BYTES,
  clientIp,
  createRateLimiter,
  rateLimit,
} from "../src/lib/hardening.js";
import { app, createApp, isPublicApiPath, PUBLIC_API_PATHS, type Env } from "../src/index.js";

/** Minimal env for tests; only the fields the middleware reads are meaningful. */
function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: {} as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
    ...overrides,
  };
}

// =======================================================================================
// resolveAccessIdentity / isDevBypassEnabled (pure)
// =======================================================================================

test("resolveAccessIdentity: no headers ⇒ null (anonymous)", () => {
  assert.equal(resolveAccessIdentity(new Headers()), null);
});

test("resolveAccessIdentity: empty/whitespace headers ⇒ null", () => {
  const h = new Headers();
  h.set(CF_ACCESS_EMAIL_HEADER, "   ");
  h.set(CF_ACCESS_JWT_HEADER, "");
  assert.equal(resolveAccessIdentity(h), null);
});

test("resolveAccessIdentity: email header alone ⇒ identity, not gated", () => {
  const h = new Headers();
  h.set(CF_ACCESS_EMAIL_HEADER, "operator@dhsc.uk");
  const id = resolveAccessIdentity(h);
  assert.deepEqual(id, { email: "operator@dhsc.uk", gated: false, dev: false });
});

test("resolveAccessIdentity: JWT assertion alone ⇒ identity, gated, email null", () => {
  const h = new Headers();
  h.set(CF_ACCESS_JWT_HEADER, "eyJhbGciOi...");
  const id = resolveAccessIdentity(h);
  assert.deepEqual(id, { email: null, gated: true, dev: false });
});

test("resolveAccessIdentity: both headers ⇒ email + gated", () => {
  const h = new Headers();
  h.set(CF_ACCESS_EMAIL_HEADER, "operator@dhsc.uk");
  h.set(CF_ACCESS_JWT_HEADER, "eyJhbGciOi...");
  const id = resolveAccessIdentity(h);
  assert.deepEqual(id, { email: "operator@dhsc.uk", gated: true, dev: false });
});

test("resolveAccessIdentity: trims the email", () => {
  const h = new Headers();
  h.set(CF_ACCESS_EMAIL_HEADER, "  operator@dhsc.uk  ");
  assert.equal(resolveAccessIdentity(h)?.email, "operator@dhsc.uk");
});

test("isDevBypassEnabled: only the exact string \"true\" arms the bypass", () => {
  assert.equal(isDevBypassEnabled({ DEV_AUTH_BYPASS: "true" }), true);
  assert.equal(isDevBypassEnabled({ DEV_AUTH_BYPASS: "false" }), false);
  assert.equal(isDevBypassEnabled({ DEV_AUTH_BYPASS: "1" }), false);
  assert.equal(isDevBypassEnabled({}), false);
  assert.equal(isDevBypassEnabled(undefined), false);
});

// =======================================================================================
// Auth guard on the real app: /api/* is closed by default
// =======================================================================================

test("GET /api/health unauthenticated ⇒ 401", async () => {
  const res = await app.request("/api/health", {}, testEnv());
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "unauthorized");
});

test("GET /api/health with Access email header ⇒ 200", async () => {
  const res = await app.request(
    "/api/health",
    { headers: { [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk" } },
    testEnv(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("GET /api/health with Access JWT assertion header ⇒ 200", async () => {
  const res = await app.request(
    "/api/health",
    { headers: { [CF_ACCESS_JWT_HEADER]: "eyJhbGciOi..." } },
    testEnv(),
  );
  assert.equal(res.status, 200);
});

test("GET /api/health with dev bypass ⇒ 200", async () => {
  const res = await app.request("/api/health", {}, testEnv({ DEV_AUTH_BYPASS: "true" }));
  assert.equal(res.status, 200);
});

test("unauthenticated /api/balance (registered later) is blocked by the group guard — 404 route still gated", async () => {
  // Phase 6 adds the real route; here we prove *any* `/api/*` path is gated even if unknown:
  // the guard runs before routing, so an anonymous caller never reaches a handler.
  const res = await app.request("/api/balance", {}, testEnv());
  assert.equal(res.status, 401);
});

test("authenticated unknown /api/* path reaches routing (404, not 401)", async () => {
  const res = await app.request(
    "/api/does-not-exist",
    { headers: { [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk" } },
    testEnv(),
  );
  assert.equal(res.status, 404);
});

test("identity is attached to the context for downstream handlers", async () => {
  // A fresh app: register the probe before first use so the matcher exists with the route.
  // The probe reads the `identity` context variable that `requireAuth` sets.
  const probe = createApp();
  probe.get("/api/whoami", (c) => c.json(c.get("identity")));

  const res = await probe.request(
    "/api/whoami",
    { headers: { [CF_ACCESS_EMAIL_HEADER]: "a@b.co" } },
    testEnv(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: "a@b.co", gated: false, dev: false });

  const devRes = await probe.request("/api/whoami", {}, testEnv({ DEV_AUTH_BYPASS: "true" }));
  assert.deepEqual(await devRes.json(), { email: DEV_IDENTITY, gated: false, dev: true });
});

// =======================================================================================
// Public opt-out carve-out
// =======================================================================================

test("isPublicApiPath: matches the opt-out path and its sub-paths, not siblings", () => {
  assert.deepEqual(PUBLIC_API_PATHS, ["/api/opt-out"]);
  assert.equal(isPublicApiPath("/api/opt-out"), true);
  assert.equal(isPublicApiPath("/api/opt-out/"), true);
  assert.equal(isPublicApiPath("/api/opt-out/123"), true);
  assert.equal(isPublicApiPath("/api/opt-outs"), false);
  assert.equal(isPublicApiPath("/api/balance"), false);
  assert.equal(isPublicApiPath("/api/opt-outish"), false);
});

test("public carve-out: an /api/opt-out sub-path is reachable without auth", async () => {
  // A route on a fresh app inherits the group middleware. The real `POST /api/opt-out`
  // handler now exists (Phase 6.7); probe a sub-path instead so this still proves the
  // carve-out is general (it matches `/api/opt-out` *and* its sub-paths) rather than
  // colliding with the registered handler.
  const publicApp = createApp();
  publicApp.get("/api/opt-out/probe", (c) => c.json({ ok: true }));

  const anon = await publicApp.request("/api/opt-out/probe", {}, testEnv());
  assert.notEqual(anon.status, 401);
  assert.equal(anon.status, 200);
  assert.deepEqual(await anon.json(), { ok: true });
});

test("public carve-out is rate-limited (429 after the window quota)", async () => {
  // Use a tiny dedicated limiter so we don't exhaust (or race) the singleton.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  const isolated = new Hono();
  isolated.get("/api/opt-out", rateLimit(limiter), (c) => c.json({ ok: true }));

  const hdrs = { "CF-Connecting-IP": "203.0.113.7" };
  assert.equal((await isolated.request("/api/opt-out", { headers: hdrs })).status, 200);
  assert.equal((await isolated.request("/api/opt-out", { headers: hdrs })).status, 200);
  const third = await isolated.request("/api/opt-out", { headers: hdrs });
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("RateLimit-Limit"), "2");
  assert.equal(third.headers.get("RateLimit-Remaining"), "0");
  assert.ok(Number(third.headers.get("Retry-After")) >= 1);

  // A different IP is unaffected.
  assert.equal(
    (await isolated.request("/api/opt-out", { headers: { "CF-Connecting-IP": "198.51.100.1" } })).status,
    200,
  );
});

// =======================================================================================
// Rate limiter internals
// =======================================================================================

test("createRateLimiter: window resets after windowMs", () => {
  let clock = 1_000;
  const limiter = createRateLimiter({ windowMs: 1_000, max: 1, now: () => clock });

  assert.equal(limiter.check("ip").allowed, true);
  assert.equal(limiter.check("ip").allowed, false);
  clock += 1_000; // advance to the reset boundary
  assert.equal(limiter.check("ip").allowed, true);
});

test("createRateLimiter: prunes expired buckets to bound memory", () => {
  let clock = 0;
  const store = new Map<string, { count: number; resetAt: number }>();
  const limiter = createRateLimiter({ windowMs: 100, max: 5, store, now: () => clock });

  for (let i = 0; i < 50; i++) limiter.check(`ip-${i}`);
  assert.equal(store.size, 50);

  clock = 1_000; // all buckets expired
  limiter.check("fresh");
  assert.ok(store.size < 50, `expected pruning, got ${store.size}`);
  assert.equal(store.has("fresh"), true);
});

test("clientIp: prefers CF-Connecting-IP, falls back to X-Forwarded-For, then 'unknown'", () => {
  const a = new Headers();
  a.set("CF-Connecting-IP", "203.0.113.7");
  a.set("X-Forwarded-For", "198.51.100.1");
  assert.equal(clientIp(a), "203.0.113.7");

  const b = new Headers();
  b.set("X-Forwarded-For", "198.51.100.1, 203.0.113.7");
  assert.equal(clientIp(b), "198.51.100.1");

  assert.equal(clientIp(new Headers()), "unknown");
});

// =======================================================================================
// Hardening: security headers + body limit
// =======================================================================================

test("security headers are applied to responses", async () => {
  const res = await app.request("/api/health", {}, testEnv({ DEV_AUTH_BYPASS: "true" }));
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'self'/);
});

test("body limit rejects an oversized request body (413)", async () => {
  const limited = createApp();
  limited.post("/api/echo", (c) => c.json({ ok: true }));
  const big = "x".repeat(MAX_BODY_BYTES + 1);
  const res = await limited.request(
    "/api/echo",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk" },
      body: big,
    },
    testEnv(),
  );
  assert.equal(res.status, 413);
});

// ======================================================================================
// Phase 11.2 — CSRF / same-origin backstop on mutating routes
// ======================================================================================

test("11.2 an unsafe request with no Origin is allowed (curl/tests/simple requests)", async () => {
  const probe = createApp();
  probe.post("/api/echo", (c) => c.json({ ok: true }));

  const res = await probe.request(
    "/api/echo",
    { method: "POST", headers: { [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk" } },
    testEnv(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("11.2 an unsafe request from the same origin (matching host) is allowed", async () => {
  const probe = createApp();
  probe.post("/api/echo", (c) => c.json({ ok: true }));

  const res = await probe.request(
    "/api/echo",
    {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk",
      },
    },
    testEnv(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("11.2 an unsafe request from a foreign Origin is rejected (403 cross_origin_blocked)", async () => {
  const probe = createApp();
  probe.post("/api/echo", (c) => c.json({ ok: true }));

  const res = await probe.request(
    "/api/echo",
    {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk",
      },
    },
    testEnv(),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "cross_origin_blocked" });
});

test("11.2 the cross-origin check also covers DELETE and reaches routing otherwise", async () => {
  const probe = createApp();
  probe.delete("/api/echo", (c) => c.json({ ok: true }));

  const blocked = await probe.request(
    "/api/echo",
    {
      method: "DELETE",
      headers: { Origin: "https://evil.example", [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk" },
    },
    testEnv(),
  );
  assert.equal(blocked.status, 403);
  assert.deepEqual(await blocked.json(), { error: "cross_origin_blocked" });

  const allowed = await probe.request(
    "/api/echo",
    { method: "DELETE", headers: { [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk" } },
    testEnv(),
  );
  assert.equal(allowed.status, 200);
});

test("11.2 GET is never blocked, even with a foreign Origin", async () => {
  const res = await app.request(
    "/api/health",
    { headers: { Origin: "https://evil.example", [CF_ACCESS_EMAIL_HEADER]: "operator@dhsc.uk" } },
    testEnv(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("11.2 a foreign Origin is blocked before auth (no Access identity still ⇒ 403)", async () => {
  // The same-origin check runs first in the guard: a cross-site attempt never reaches auth,
  // so it cannot even probe whether it is authenticated.
  const res = await app.request("/api/balance", { method: "POST", headers: { Origin: "https://evil.example" } }, testEnv());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "cross_origin_blocked" });
});

test("11.2 the public opt-out mutation is protected too (foreign Origin ⇒ 403)", async () => {
  const res = await app.request(
    "/api/opt-out",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example",
      },
      body: "number=07700900002",
    },
    testEnv(),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "cross_origin_blocked" });
});

test("11.2 the public form post with the same (production) origin still succeeds", async () => {
  const res = await app.request(
    "/api/opt-out",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // The `/x` page posts same-origin; the browser sends this Origin.
        Origin: "http://localhost",
      },
      body: "number=12345",
    },
    testEnv(),
  );
  // Reaches the handler (which rejects the invalid number) rather than the origin check.
  assert.equal(res.status, 400);
});
