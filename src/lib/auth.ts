/**
 * Authentication & request-guard middleware — the single gate that keeps every `/api/*`
 * route closed to anonymous callers except the public opt-out path (tech.md §5 "Auth rule",
 * mission.md §6.4, hard rule #2 in agent.md).
 *
 * How auth works here (tech.md §9.1, mission.md §8.1):
 *   - Presentation is handled by **Cloudflare Access (Zero Trust)** in front of `dhsc.uk`
 *     and all `/api/*`. Access is the *only* ingress, so by the time a request reaches the
 *     Worker an authenticated user already carries identity headers, and an anonymous
 *     request carries none.
 *   - Per mission.md §8 "Access JWT verification" (still-open, assumed): we **trust the
 *     header** rather than re-verifying the JWT signature in the Worker. Revisit if the
 *     Worker is ever exposed beyond Access.
 *
 * This module is deliberately dependency-light: only Hono types, no provider calls, no
 * Cloudflare-specific crypto. It must stay cheap (hard rule #5: ≤10 ms CPU).
 */

import type { Context, MiddlewareHandler } from "hono";

// Make the resolved identity a first-class context variable so `c.get("identity")` is typed
// everywhere without threading a Variables generic through Hono's overloads.
declare module "hono" {
  interface ContextVariableMap {
    identity: AuthIdentity;
  }
}

/** Header Cloudflare Access sets to the authenticated user's email (our primary identity). */
export const CF_ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";

/** Header Cloudflare Access sets carrying the signed JWT assertion (presence ⇒ gated). */
export const CF_ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Env slice the auth middleware reads. Extendable so `src/index.ts` can pass the full
 * `Env` without this module importing Worker-only types.
 */
export interface AuthEnv {
  /**
   * Dev-only bypass switch. When the string `"true"`, requests are accepted and treated as
   * the configured dev identity. Must be absent/`"false"` in production so the live gate is
   * never opened by accident.
   */
  DEV_AUTH_BYPASS?: string;
  /** Identity to assume when `DEV_AUTH_BYPASS` is on (defaults to `DEV_IDENTITY`). */
  DEV_AUTH_EMAIL?: string;
}

/** Identity assumed for a dev-bypass request when `DEV_AUTH_EMAIL` is not set. */
export const DEV_IDENTITY = "dev@localhost";

/**
 * The authenticated identity attached to a request context. `email` may be `null` when the
 * request was gated but Access only supplied the JWT assertion (no email header), in which
 * case `gated` is `true` and we still accept.
 */
export interface AuthIdentity {
  /** Authenticated user's email, if Access provided it. */
  email: string | null;
  /** True when a Cloudflare Access JWT assertion header was present. */
  gated: boolean;
  /** True when this identity came from the dev bypass rather than Access. */
  dev: boolean;
}

/** Shape of the `identity` context variable this middleware sets. */
export interface AuthVariables {
  identity: AuthIdentity;
}

/** True when the dev bypass is armed (exactly the string `"true"`). */
export function isDevBypassEnabled(env: AuthEnv | undefined): boolean {
  return env?.DEV_AUTH_BYPASS === "true";
}

/**
 * Resolve the identity from request headers, or `null` when the request is anonymous.
 *
 * A request is considered authenticated when **either** Access identity header is present:
 *   - `Cf-Access-Authenticated-User-Email` (preferred — carries the email), or
 *   - `Cf-Access-Jwt-Assertion` (Access signed it; email may be absent).
 *
 * Pure and synchronous so it is trivially unit-testable without a Worker runtime.
 */
export function resolveAccessIdentity(headers: Headers): AuthIdentity | null {
  const email = (headers.get(CF_ACCESS_EMAIL_HEADER) ?? "").trim();
  const assertion = (headers.get(CF_ACCESS_JWT_HEADER) ?? "").trim();
  const hasEmail = email !== "";
  const hasAssertion = assertion !== "";
  if (!hasEmail && !hasAssertion) return null;
  return { email: hasEmail ? email : null, gated: hasAssertion, dev: false };
}

/**
 * Hono middleware: reject anonymous requests with `401`, otherwise attach the identity to
 * the context (`c.set("identity", …)`) and continue.
 *
 * Dev bypass (`DEV_AUTH_BYPASS === "true"`) accepts the request as the configured dev
 * identity **without** requiring Access headers — used by `wrangler dev` / tests. It is
 * opt-in only and never triggered by a client-supplied value.
 *
 * Typed as a factory so the returned handler is assignable to any app whose `Bindings`
 * extend `AuthEnv` (Hono's middleware env is contravariant; a fixed concrete `Env` here
 * would not accept the app's richer bindings). The module reads only `AuthEnv` fields.
 */
export function createRequireAuth<E extends AuthEnv>(): MiddlewareHandler<{ Bindings: E; Variables: AuthVariables }> {
  return async (c, next) => {
    const env = c.env;
    const identity = isDevBypassEnabled(env)
      ? { email: env.DEV_AUTH_EMAIL?.trim() || DEV_IDENTITY, gated: false, dev: true }
      : resolveAccessIdentity(c.req.raw.headers);

    if (!identity) {
      return c.json({ error: "unauthorized", message: "Authentication required." }, 401);
    }

    c.set("identity", identity);
    await next();
  };
}

/** Singleton auth guard; callers may also use `createRequireAuth` for a typed instance. */
export const requireAuth = createRequireAuth<AuthEnv>();

/** Read the resolved identity off a context (throws only if used before `requireAuth`). */
export function getIdentity(c: Context): AuthIdentity {
  const identity = c.get("identity");
  if (!identity) throw new Error("getIdentity() called before requireAuth middleware ran");
  return identity;
}
