/**
 * Build-time runtime configuration for the dashboard.
 *
 * The sender ID is a **provisioned** value, not something the operator invents per campaign
 * (mission.md §8.3). It is injected at build time via Vite env vars so no value is hardcoded in
 * a component and the same build shape works for dev and production:
 *
 *   - `VITE_SENDER_ID`    — the registered UK sender ID (≤11 chars; letters, digits, spaces).
 *   - `VITE_ENVIRONMENT`  — a label for the header's environment pill (e.g. `Production`).
 *
 * Both have safe defaults so a local `npm run dev` works out of the box. Set them in a
 * `web/.env.local` (gitignored) or as build env when deploying.
 */

const rawSenderId = (import.meta.env.VITE_SENDER_ID as string | undefined)?.trim();

/** The sender ID posted with every campaign/test send. */
export const SENDER_ID = rawSenderId && rawSenderId.length > 0 ? rawSenderId : "DHSC";

/**
 * Whether the sender ID was explicitly configured. When false the UI still works (using the
 * default) but we can surface a subtle warning so a misconfigured deploy is noticed.
 */
export const SENDER_ID_CONFIGURED = Boolean(rawSenderId && rawSenderId.length > 0);

/** Header environment pill label; defaults to `Production` since this is the live dashboard. */
export const ENVIRONMENT_LABEL =
  (import.meta.env.VITE_ENVIRONMENT as string | undefined)?.trim() || "Production";

/** The opt-out suffix shown in previews — must match `web/src/lib/sms.ts` and the Worker. */
export { OPT_OUT_SUFFIX } from "./lib/sms";
