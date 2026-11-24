/**
 * Worker binding + app-environment types.
 *
 * Kept in its own module (not `src/index.ts`) so route/service modules can import the types
 * without a circular dependency on the app factory. `src/index.ts` re-exports these for
 * back-compat with the Phase 5 tests that import `type Env` from there.
 */

import type { AuthEnv, AuthVariables } from "./lib/auth.js";

/** Cloudflare bindings available to the Worker. */
export interface Env extends AuthEnv {
  /** D1 database (schema: `src/db/schema.ts`). */
  DB: D1Database;
  /** Static-asset binding for the built SPA (`web/dist`). */
  ASSETS: Fetcher;
  /** Producer binding for the campaign job queue. */
  SMS_QUEUE: Queue;
  /** Sendmode access key (secret; never committed). */
  SENDMODE_ACCESS_KEY: string;
}

/** Hono environment for the app: bindings plus the `identity` context variable. */
export interface AppEnv {
  Bindings: Env;
  Variables: AuthVariables;
}
