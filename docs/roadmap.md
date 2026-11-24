# Roadmap — DHSC (Dilli Haat SMS Campaign)

> **How to use this file (agents):** implement **one numbered step at a time**, in order.
> Each step is deliberately small ("nano") so a human can review it before the next one
> starts. Do **not** jump ahead. After each step, run the step's **Verify** and report what
> you ran and observed. If a step is ambiguous, stop and ask — don't guess.
>
> Legend: **[Q]** = answer an open question first (see `mission.md` §8). **[BLOCKER]** = cannot
> proceed until resolved.

---

## Phase 0 — Decisions & Groundwork (no product code yet)

> Most decisions are **resolved** (see `mission.md` §8). Only 0.6 and the two footnotes in
> §8 remain soft — do not block on them.

- **0.1 ✅** Hosted at **`dhsc.uk`**, auth via simple password **Cloudflare Access (Zero Trust)**.
- **0.2 ✅** Opt-out is a **public web page** (phone-number form) — the only unauthenticated route.
- **0.3 ✅** **Sender ID is provisioned** with the provider; treat as a fixed configured value.
- **0.4 ✅** **160 chars is a hard max** (GSM-7); suffix is appended first, remaining budget is
  the operator's. Emoji → UCS-2 changes budget/cost.
- **0.5 ✅** CSV has **~8,000–8,500 records** → **~80–85 chunks** at 100/chunk.
- **0.6 ✅** **Test SMS appears in History** (marked as a test send).
- **0.7 ⏸ Webhooks deferred:** terminal state is provider acceptance (`request_id`). Do not
  build webhook consumption now.
- **0.8 ✅ Defaults:** `max_batch_size: 5`, `max_concurrency: 2`, `max_retries: 5`.
- **Verify:** decisions §8 in `mission.md` read as facts; no remaining hard blockers.

---

## Phase 1 — Project Skeleton

- **1.1** Create `package.json` with scripts: `dev`, `build`, `deploy`, `db:generate`,
  `db:migrate:local`, `db:migrate:remote`, `seed`.
- **1.2** Add dev deps: `wrangler`, `drizzle-orm`, `drizzle-kit`, `hono`, `typescript`,
  `tsx`, `vite`, `@vitejs/plugin-react`, React + Tailwind tooling. Keep the list minimal.
- **1.3** Add `tsconfig.json` (strict) covering `src/`.
- **1.4** Author `wrangler.jsonc` exactly per `tech.md` §3 (placeholder `database_id`).
- **1.5** Create `src/index.ts` exporting a minimal Hono app with a `GET /api/health` route
  and a no-op `queue()` export.
- **Verify:** `npx wrangler dev` starts; `GET /api/health` returns `200`.

---

## Phase 2 — Database & Schema

- **2.1 ✅** `src/db/schema.ts` (Drizzle `sqliteTable`): `audienceChunks`, `campaigns`,
  `campaignBatches`, `optOuts`, mirroring `tech.md` §4 (+ `campaigns.is_test`).
- **2.2 ✅** `drizzle.config.ts` (dialect `sqlite`, driver `d1-http`, output `src/db/migrations`).
  Credentials are env-driven so no account id/token is committed.
- **2.3 ✅** Ran `drizzle-kit generate`; SQL inspected before applying.
- **2.4 ✅** Applied locally: `wrangler d1 migrations apply … --local`.
- **2.5 ✅** Remote apply done. D1 database `sms-campaigns-db` created; real
  `database_id` (`ae8b894d-e41d-4061-9678-e3ed4edef921`) wired into `wrangler.jsonc`; duplicate
  auto-generated binding removed so only `DB` remains.
- **Verify ✅** `wrangler d1 execute sms-campaigns-db --remote --command "select name from sqlite_master"` lists all four tables + index.
- **Verify:** `wrangler d1 execute sms-campaigns-db --local --command "select name from sqlite_master"` lists all four tables + index.

---

## Phase 3 — Audience Seeding

- **3.1** Write `scripts/seed-audience.ts`: read the cleaned CSV (`name,phone`), normalize to
  E.164 (`+44…`), chunk into groups of **100**, and generate a SQL file (or prepared inserts)
  for `audience_chunks` with `chunk_index`, `recipient_count`, `mobile_numbers_json`.
- **3.2** Ensure the script is idempotent (clear/`INSERT OR REPLACE`) and never exceeds D1's
  100-bound-parameter rule (each row is one statement; batch many statements, not many
  placeholders).
- **3.3** Seed locally, then remotely.
- **Verify:** `select count(*) from audience_chunks` and `sum(recipient_count)` match the CSV's
  number count; spot-check one `mobile_numbers_json` parses to 100 valid `+44…` numbers.

---

## Phase 4 — Sendmode Service Layer (no HTTP yet)

- **4.1** `src/services/sendmode.ts`: typed wrappers for `getBalance`, `sendBulk`,
  `scheduleBulk`, `cancelSchedule`. Base URL `https://sms-rest.sendmode.dev`; bare
  `Authorization`; `Content-Type: application/json` on every body incl. DELETE.
- **4.2** `src/services/sms-segments.ts`: pure functions — detect GSM-7 vs UCS-2, count
  characters, compute segments (160/70 rule for single-segment; multi-segment 153/67), and
  `estimatedCredits(segments, recipients)`.
- **4.3** `src/lib/uk-time.ts`: parse a `Europe/London` local datetime → validate 15-min
  alignment, `:00` seconds, ≥20 min lead → produce ISO 8601 UTC `Z` string. Handle GMT/BST.
- **4.4** `src/lib/validate.ts`: campaign input validation (`name`, `sender_id` ≤11 no `<>`,
  `message` 1–1224 no `<>`, schedule rules) + E.164 UK phone validation/normalization.
- **Verify:** unit-level checks (a small `node --test`/`vitest` file) for segment math
  (incl. emoji → UCS-2), UK→UTC conversion across a BST and a GMT date, and validation edge
  cases.

---

## Phase 5 — Auth & Middleware

- **5.1** `src/lib/auth.ts`: middleware that reads the Cloudflare Access identity
  (`Cf-Access-Jwt-Assertion` / `Cf-Access-Authenticated-User-Email`) and **rejects
  unauthenticated requests with `401`**; for local dev, support a dev bypass flag.
- **5.2** Apply the auth middleware to the whole `/api/*` group in `src/index.ts`, with an
  explicit carve-out list for the public opt-out route only.
- **5.3** Add baseline hardening middleware: security headers, request-size limit, simple
  in-memory/IP rate limiting for the public route.
- **Verify:** unauthenticated `GET /api/balance` → `401`; with a dev identity → passes
  through. Confirm no `/api/*` route is reachable anonymously.

---

## Phase 6 — Core API Endpoints

- **6.1** `GET /api/balance`: proxy `getBalance`, return `{ balance, audience_count }`
  (`audience_count` from `sum(recipient_count)` minus opt-outs).
- **6.2** `POST /api/campaigns`: validate → pre-flight balance check → single
  `env.DB.batch([...])` insert of campaign + all batch rows (`QUEUED`/`PENDING`) → enqueue via
  `sendBatch()` in slices of 100 → `202`.
- **6.3** `GET /api/campaigns`: list with `?filter=upcoming|history`, ordered `created_at DESC`.
- **6.4** `GET /api/campaigns/:id`: live progress + invalid count + per-batch errors.
- **6.5** `POST /api/campaigns/:id/cancel`: per `tech.md` Flow B → `202`.
- **6.6** `POST /api/test-sms`: single unscheduled test to one UK number; **record it in
  History** (flagged as a test send).
- **6.7** Opt-out endpoints (authenticated list/add/remove) + the **public opt-out page/route**
  (the only unauthenticated route; validated + rate-limited).
- **Verify:** exercise each endpoint with a dev identity against local D1 + a mocked
  Sendmode; assert status codes, D1 rows created, and that enqueue counts are correct.

---

## Phase 7 — Queue Consumer

- **7.1** `src/queue/dispatch.ts`: `DISPATCH_BATCH` handler with the idempotency + cancel
  race guards from `tech.md` Flow C.
- **7.2** `src/queue/cancel.ts`: `CANCEL_BATCH` handler.
- **7.3** Wire the `queue()` export in `src/index.ts` to route by `type`.
- **7.4** Implement retry policy (`msg.retry({ delaySeconds: 10 * attempts })` on
  429/5xx/network; `ack` on 400/401 with `FAILED`).
- **7.5** Implement campaign-total recomputation → terminal status
  (`SENT`/`SCHEDULED`/`PARTIAL_FAILURE`/`CANCELLED`).
- **Verify:** with a mocked provider, run a local queue (`wrangler dev` + queue producer
  simulation) and assert: batches transition correctly, cancelling mid-flight skips sends,
  retries fire on 5xx, and campaign reaches the right terminal status.

---

## Phase 8 — Frontend Shell (React + Vite + Tailwind)

- **8.1** Scaffold `web/` with Vite + React + Tailwind; configure dev proxy `/api` → Worker.
- **8.2** Build the layout shell per `prototype.md` (§2–3): sticky header (brand, Opt-Outs
  count, Sync Balance, environment pill, **Sign Out**), page canvas, container.
- **8.3** Build the **Credit Health Monitor** (§4): deficit banner + 3 KPI cards wired to
  `/api/balance` and campaign data.
- **8.4** Build the **Create Campaign** panel (§5.1): name, read-only All-Contacts audience
  with sanitization strip, message textarea with live estimator (encoding/char/segments/
  recipients/cost), schedule radio + UK picker, Test/Send/Schedule buttons with guards.
- **8.5** Build the **Queued & History** panel (§5.2): tabs with counts, campaign cards,
  3-metric strip, countdowns, cancel button.
- **8.6** Build modals (§6): Send Test SMS, Opt-Out Blacklist, Cancel Confirmation — with
  Escape dismissal, focus trapping, `role="dialog"`, `aria-modal`.
- **8.7** Add empty states, loading/disabled states, and toast/inline error+success feedback.
- **Verify:** local dev shows all panels with live data; form guards disable Send/Schedule on
  invalid input or insufficient balance; modals are accessible.

---

## Phase 9 — End-to-End Wiring

- **9.1** Immediate campaign end-to-end: create → queue → batches `SENT` → History shows it.
- **9.2** Scheduled campaign end-to-end: create → batches `SCHEDULED` → Queued view + countdown.
- **9.3** Cancellation end-to-end: cancel → `CANCELLING` → provider DELETEs → `CANCELLED`.
- **9.4** Test SMS end-to-end.
- **9.5** Opt-out add/remove updates the valid recipient count everywhere.
- **Verify:** walk all five flows in a local full-stack run; capture request/response evidence.

---

## Phase 10 — Polish, Security, Deploy

- **10.1** Confirm the committed `.dev.vars` contains **no live production key**; move the real
  key to `wrangler secret put SENDMODE_ACCESS_KEY`.
- **10.2** Review rate limiting on the public opt-out route; confirm security headers.
- **10.3** `npm run build` → confirm `web/dist` is produced and served via `ASSETS`.
- **10.4** `npx wrangler deploy`; smoke-test in production with a single test SMS and a tiny
  (1-chunk) campaign.
- **10.5** Add a short `README`/runbook if useful; update docs to reflect reality.
- **Verify:** production dashboard loads behind Cloudflare Access; anonymous access blocked;
  one real test SMS delivered; rollback plan documented.

---

## Backlog / Later (only if the mission expands)

- Consume Sendmode **webhooks** for real delivery status (deferred decision, `mission.md` §8.7).
- Admin UI to re-seed the audience from a new CSV without a local script.
- Per-campaign analytics (delivered/failed over time).
- Scheduled campaign auto-retry if a batch hits a transient outage near the lead time.
