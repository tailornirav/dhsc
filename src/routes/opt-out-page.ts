/**
 * Public opt-out page — `GET /x` (roadmap Phase 9.5).
 *
 * Context: every outbound SMS ends with `Stop: dhsc.uk/x` (`OPT_OUT_SUFFIX`), so a customer who
 * texts/clicks needs a real page at that path. The **API** they submit to (`POST /api/opt-out`)
 * already exists and writes to D1 (`src/routes/opt-outs.ts`); this module only renders the form.
 *
 * Deliberate scope (Phase 9.5 is an isolated add-on — it must not touch the working app):
 *   - **No business logic.** The handler does zero DB work and reuses the existing public
 *     `/api/opt-out` endpoint, so no validation/normalisation is duplicated.
 *   - **No JS, no framework, no build step.** The page is self-contained HTML + inline `<style>`
 *     (CSP already permits inline styles; scripts stay `'self'`-only, and there are none here).
 *     It is served as a plain string so it is reachable in every environment — including tests,
 *     where the `ASSETS` binding is a stub with no built `web/dist`.
 *   - **Same origin.** The form posts to `/api/opt-out` on this origin, so it keeps working under
 *     the strict CSP (`form-action 'self'`) with no CORS layer.
 *
 * The identical static copy at `web/public/x.html` (copied verbatim into `web/dist` by Vite and
 * served through the `ASSETS` binding) is asserted equal to this string by `test/phase9_5.test.ts`,
 * so the two can never drift.
 *
 * Auth: `/x` is **not** under `/api/*`, so the existing `/api/*` guard already ignores it.
 * `PUBLIC_API_PATHS` stays exactly `["/api/opt-out"]` — this phase does not widen the public API.
 */

import type { Hono } from "hono";

import type { AppEnv } from "../env.js";

/**
 * The standalone opt-out page. Kept as a plain string (not a template with interpolation) so it
 * is byte-for-byte comparable with `web/public/x.html` in the test.
 */
export const OPT_OUT_PAGE_HTML = `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Stop messages — Dilli Haat</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        line-height: 1.5;
        color: #0f172a;
        background: #f1f5f9;
      }
      @media (prefers-color-scheme: dark) {
        body {
          color: #e2e8f0;
          background: #0f172a;
        }
      }
      main {
        width: 100%;
        max-width: 26rem;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 0.75rem;
        padding: 2rem;
        box-shadow: 0 10px 25px -5px rgb(15 23 42 / 0.12);
      }
      @media (prefers-color-scheme: dark) {
        main {
          background: #1e293b;
          border-color: #334155;
        }
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: 1.375rem;
      }
      p {
        margin: 0 0 1.25rem;
        font-size: 0.95rem;
      }
      label {
        display: block;
        margin-bottom: 0.375rem;
        font-size: 0.9rem;
        font-weight: 600;
      }
      input[type="tel"] {
        width: 100%;
        padding: 0.75rem 0.875rem;
        font-size: 1rem;
        color: inherit;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 0.5rem;
      }
      input[type="tel"]:focus {
        outline: 2px solid #0ea5e9;
        outline-offset: 1px;
        border-color: #0ea5e9;
      }
      @media (prefers-color-scheme: dark) {
        input[type="tel"] {
          background: #0f172a;
          border-color: #475569;
        }
      }
      button {
        margin-top: 1rem;
        width: 100%;
        padding: 0.75rem 1rem;
        font-size: 1rem;
        font-weight: 600;
        color: #ffffff;
        background: #0f766e;
        border: 0;
        border-radius: 0.5rem;
        cursor: pointer;
      }
      button:hover {
        background: #115e59;
      }
      .notice {
        margin: 1.5rem 0 0;
        padding-top: 1.25rem;
        border-top: 1px solid #e2e8f0;
        font-size: 0.85rem;
        color: #475569;
      }
      @media (prefers-color-scheme: dark) {
        .notice {
          border-color: #334155;
          color: #94a3b8;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Stop receiving messages</h1>
      <p>
        Enter the mobile number you want to remove. You will not receive any further campaign
        messages from Dilli Haat.
      </p>
      <form action="/api/opt-out" method="post">
        <label for="number">Mobile number</label>
        <input
          id="number"
          name="number"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          placeholder="07700 900000"
          required
        />
        <button type="submit">Opt out</button>
      </form>
      <p class="notice">
        This removes the number from all future campaigns. If you change your mind, contact the
        restaurant to be added back.
      </p>
    </main>
  </body>
</html>
`;

export function registerOptOutPageRoutes(app: Hono<AppEnv>): void {
  // `GET /x` — the customer-facing page behind `Stop: dhsc.uk/x`. Pure rendering; the form posts
  // to the existing public `POST /api/opt-out` handler, which is where all opt-out logic lives.
  app.get("/x", (c) => c.html(OPT_OUT_PAGE_HTML));
}
