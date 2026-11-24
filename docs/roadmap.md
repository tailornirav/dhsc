# Roadmap — DHSC (Dilli Haat SMS Campaign)

> **How to use this file (agents):** implement **one numbered step at a time**, in order.
> Each step is deliberately small ("nano") so a human can review it before the next one
> starts. Do **not** jump ahead. After each step, run the step's **Verify** and report what
> you ran and observed. If a step is ambiguous, stop and ask — don't guess.
>
> Legend: **[Q]** = answer an open question first (see `mission.md` §8). **[BLOCKER]** = cannot
> proceed until resolved.

---

## Phase 0 — Decisions & Groundwork ✅ DONE (no product code yet)

> Phase complete: all decisions resolved and Phase 0 verified. 0.7 is now a **closed**
> decision (webhooks not needed).

- **0.1 ✅** Hosted at **`dhsc.uk`**, auth via simple password **Cloudflare Access (Zero Trust)**.
- **0.2 ✅** Opt-out is a **public web page** (phone-number form) — the only unauthenticated route.
- **0.3 ✅** **Sender ID is provisioned** with the provider; treat as a fixed configured value.
- **0.4 ✅** **160 chars is a hard max** (GSM-7); suffix is appended first, remaining budget is
  the operator's. Emoji → UCS-2 changes budget/cost.
- **0.5 ✅** CSV has **~8,000–8,500 records** → **~80–85 chunks** at 100/chunk.
  *(Resolved in Phase 3: 8,093 data rows → 8,060 clean → 81 chunks.)*
- **0.6 ✅** **Test SMS appears in History** (marked as a test send).
- **0.7 ✅ Webhooks not needed:** terminal state is provider acceptance (`request_id`). No
  webhook endpoint/consumption will be built — there is no per-message delivery status to
  update.
- **0.8 ✅ Defaults:** `max_batch_size: 5`, `max_concurrency: 2`, `max_retries: 5`.
- **Verify ✅** decisions §8 in `mission.md` read as facts; no remaining hard blockers.

---

## Phase 1 — Project Skeleton ✅ DONE

- **1.1** Create `package.json` with scripts: `dev`, `build`, `deploy`, `db:generate`,
  `db:migrate:local`, `db:migrate:remote`, `seed`.
- **1.2** Add dev deps: `wrangler`, `drizzle-orm`, `drizzle-kit`, `hono`, `typescript`,
  `tsx`, `vite`, `@vitejs/plugin-react`, React + Tailwind tooling. Keep the list minimal.
- **1.3** Add `tsconfig.json` (strict) covering `src/`.
- **1.4** Author `wrangler.jsonc` exactly per `tech.md` §3 (placeholder `database_id`).
- **1.5** Create `src/index.ts` exporting a minimal Hono app with a `GET /api/health` route
  and a no-op `queue()` export.
- **Verify ✅** `npx wrangler dev` starts; `GET /api/health` returns `200`.

---

## Phase 2 — Database & Schema ✅ DONE

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

---

## Phase 3 — Audience Seeding ✅ DONE

> **Reality vs docs (resolved):** the file is `docs/data.csv` with header
> `customer_name,phone_e164,visit_count` (not the roadmap's `name,phone`). It was described as
> "pre-cleaned" but is **not** fully clean: of 8,093 data rows, **8,060** are clean UK mobiles
> (`+44` + 7 + 9 digits), **32** have a duplicated `44` (`+44447…`) and **1** is a structurally
> corrupt row (`"BON ,+44ARRIOT ",7725434197,0`). **Decision: seed only the 8,060 clean rows**;
> all 33 dirty rows are dropped and logged by the seeder (no guessing on who gets paid SMS).

- **3.1 ✅** `scripts/seed-audience.ts`: reads `docs/data.csv`, keeps only `/^\+447\d{9}$/`,
  chunks into groups of **100**, and emits idempotent SQL for `audience_chunks` with
  `chunk_index`, `recipient_count`, `mobile_numbers_json`.
- **3.2 ✅** Idempotent (`DELETE` then one `INSERT OR REPLACE` per row; `chunk_index` UNIQUE) and
  within D1 limits: each row is a single statement binding 3 values (the JSON array is one text
  value, never 100 placeholders).
- **3.3 ✅** Seeded locally, then remotely.
- **Verify ✅** `count(*) = 81`, `sum(recipient_count) = 8060` (== clean CSV rows) on both local
  and remote; every number valid `+44…` and distinct (`json_each` sweep: 8060/8060 valid, 8060
  distinct); chunk 0 `json_array_length = 100`, chunk 80 = 60; re-running the seed is a no-op.

---

## Phase 4 — Sendmode Service Layer (no HTTP yet) ✅ DONE

> **Decisions made while building (recorded here, not guessed):**
> - **Testing:** Node's built-in test runner (`node --test`) via `tsx` — **no new dependency**
>   (matches the $0 / minimal-toolchain rule; roadmap allowed `node --test`/`vitest`). Run with
>   `npm test`; `npm run typecheck` checks `src/`, and `test/tsconfig.json` type-checks the
>   tests (Node + Workers types kept separate so `fetch`/`Response` don't clash).
> - **Opt-out suffix constant:** `Stop: dhsc.uk/x` (15 septets), appended after **one separator
>   space**; the operator's GSM-7 single-segment budget is therefore **160 − 15 − 1 = 144**
>   characters. Defined once as `OPT_OUT_SUFFIX` in `src/lib/validate.ts`.
> - **Hard cap = single segment:** the outbound body (text + suffix) must fit **one** segment
>   (160 GSM-7 / 70 UCS-2); anything longer is rejected so cost can never silently double.
> - **`sendmode.ts` returns a discriminated result** (`{ok:true,...}` / `{ok:false,reason,...}`)
>   instead of throwing — retry/terminal policy stays in Phase 7 (the queue), not in the
>   service. `accessKey`/`fetch`/`baseUrl` are injectable so calls are unit-testable without
>   the network.
> - **`uk-time.ts` DST** is derived from `Intl.DateTimeFormat({timeZone:'Europe/London'})`
>   via a guess-and-correct step (no hardcoded offset, no `moment`/`luxon`).

- **4.1 ✅** `src/services/sendmode.ts`: typed `getBalance`, `sendBulk`, `scheduleBulk`,
  `cancelSchedule`. Base URL `https://sms-rest.sendmode.dev`; **bare** `Authorization` (never
  `Bearer`); `Content-Type: application/json` on every body incl. `DELETE /3.0/schedule`.
- **4.2 ✅** `src/services/sms-segments.ts`: `detectEncoding` (GSM-7 vs UCS-2 using the full
  3GPP TS 23.038 basic + extension tables), `analyzeSegments` (extension chars = 2 septets;
  single 160/70, multipart 153/67), and `estimatedCredits(segments, recipients)`.
- **4.3 ✅** `src/lib/uk-time.ts`: `parseUkLocal` → `validateUkSchedule` (real calendar date,
  minutes ∈ {00,15,30,45}, seconds `:00`, ≥20 min lead, ≤2-year sanity guard) → ISO 8601 UTC
  `Z`. Handles GMT/BST and deterministic DST-transition resolution.
- **4.4 ✅** `src/lib/validate.ts`: `validateCampaign` (`name` ≤80, `sender_id` ≤11 alphanumeric
  no `<>`, `message` no `<>` + single-segment budget, schedule rules) and UK E.164
  validation/normalization (`normalizeUkMobile`/`isValidUkMobile`).
- **Verify ✅** `npm test` → **37/37 pass** (`test/phase4.test.ts`): GSM-7/UCS-2 boundaries &
  emoji flip, extension-char cost, credit math; UK→UTC across a **BST** and a **GMT** date
  plus the 20-min boundary; validation edge cases; and mocked-fetch checks of every provider
  request's URL, method, **bare** auth header, JSON body (incl. the DELETE quirk), and the
  `400/401/429/5xx/network/invalid-shape` → reason mapping. `npx tsc --noEmit` (src) and
  `npx tsc --noEmit -p test/tsconfig.json` are clean; `wrangler deploy --dry-run` bundles.

---

## Phase 5 — Auth & Middleware ✅ DONE

> **Decisions made while building (recorded here, not guessed):**
> - **Trust the Access header, don't verify the JWT.** Per `mission.md` §8 "Access JWT
>   verification" (still-open; assumed), Cloudflare Access is the *only* ingress, so the
>   Worker trusts `Cf-Access-Authenticated-User-Email` / `Cf-Access-Jwt-Assertion` and does
>   **not** re-verify the signature. Revisit if the Worker is ever exposed beyond Access.
> - **Identity = "either Access header present".** Email header gives the email; a bare JWT
>   assertion (no email) is still accepted (`email: null`, `gated: true`). Stored on the
>   context as `identity` (Hono `ContextVariableMap` augmentation) so routes never re-parse
>   headers.
> - **Dev bypass is opt-in and explicit.** `DEV_AUTH_BYPASS === "true"` accepts the request
>   as `DEV_AUTH_EMAIL` (default `dev@localhost`). Absent/`"false"` ⇒ the live gate is
>   closed, so production can never be opened by accident.
> - **Carve-out is a deny-by-default list.** `PUBLIC_API_PATHS = ['/api/opt-out']`; every
>   other `/api/*` path is guarded, so a new route is protected unless explicitly listed.
>   The opt-out handler itself arrives in 6.7 — 5.2 only establishes the guard + limiter.
> - **Hardening uses Hono built-ins** (`secureHeaders`, `bodyLimit`) — no new dependency
>   (hard rule #1). The **in-memory rate limiter** is hand-rolled (per-isolate, best-effort,
>   documented as such); swap the store for a Cloudflare-native limiter later without
>   changing callers.
> - **`createApp()` factory** exported so tests build a fresh app (Hono freezes its matcher
>   on first request, so probe routes must be added before use).

- **5.1 ✅** `src/lib/auth.ts`: `resolveAccessIdentity` (pure), `isDevBypassEnabled`,
  `createRequireAuth<Env>()` middleware → **401** when anonymous, else sets `identity`;
  `getIdentity(c)` for handlers.
- **5.2 ✅** `src/index.ts`: one guard on `/api/*` with the explicit `PUBLIC_API_PATHS`
  carve-out (deny-by-default); public paths are rate-limited instead of authenticated.
- **5.3 ✅** `src/lib/hardening.ts`: security headers (tight CSP, `X-Frame-Options: DENY`,
  `nosniff`, referrer policy, COOP), a 64 KiB `bodyLimit`, and a fixed-window in-memory
  IP rate limiter (`clientIp` prefers `CF-Connecting-IP` → `X-Forwarded-For` → `unknown`).
- **Verify ✅** `npm test` → **59/59 pass** (37 from Phase 4 + 22 in `test/phase5.test.ts`):
  anonymous `GET /api/health` and `GET /api/balance` → **401**; email/JWT/dev-bypass → 200;
  unknown authenticated `/api/*` → 404 (routing reached, not 401); opt-out carve-out reachable
  without auth but 429 after the quota; header/body-limit/prune/clip checks. `npx tsc --noEmit`
  (src) and `-p test/tsconfig.json` clean; `wrangler deploy --dry-run` bundles.

---

## Phase 6 — Core API Endpoints ✅ DONE

> **Decisions made while building (recorded here, not guessed):**
> - **Raw D1 + prepared statements, not a query builder in the hot path.** Schema still comes
>   from Drizzle; runtime access goes through `src/db/client.ts` (`firstRow`/`allRows`/
>   `runStatement`) so every query is explicit and stays inside D1's 50-queries/invocation and
>   100-params limits. Multi-row writes use one `env.DB.batch([...])` (hard rule #4).
> - **Route modules + services, thin handlers.** `src/routes/*` only parse/validate/shape HTTP;
>   all persistence/orchestration lives in `src/services/*` (`audience`, `campaigns`,
>   `opt-outs`, `test-sms`). The queue fan-out lives in the service, so no provider call is
>   ever made in an HTTP request loop (hard rule #3).
> - **Typed queue contract** in `src/queue/messages.ts` (`DISPATCH_BATCH` | `CANCEL_BATCH`),
>   shared by the Phase 6 producer and the Phase 7 consumer so fields cannot drift. Slicing is
>   `chunkArray(..., 100)` → the 81-chunk campaign is **one** `sendBatch()`, 101+ is split.
> - **Test SMS = a flagged 1-recipient campaign.** `is_test = 1`, one batch, enqueued like any
>   other send. It is **not** blocked by balance (1 credit) and needs no `audience_chunks` row,
>   so `DispatchBatchMessage.recipients` carries the number inline; real batches still load
>   their chunk by `chunkIndex`. `TEST_CHUNK_INDEX = -1` is the batch's sentinel.
> - **Opt-out naming keeps the guard exact:** `/api/opt-outs` (plural) is authenticated
>   management; `/api/opt-out` (singular) is the public page — preserving the Phase 5
>   `PUBLIC_API_PATHS = ['/api/opt-out']` carve-out. The public handler accepts JSON (SPA) **and**
>   urlencoded form posts (no-JS page), and returns a neutral message whether or not the number
>   was already present.
> - **Pre-flight safety:** a create/send is blocked (`400 insufficient_balance`) when the live
>   balance cannot cover `segments × recipients`; a provider outage on `/api/balance` or the
>   create pre-check is a `502` (we are the gateway) rather than a silent pass.
> - **Cancel** marks `CANCELLING`, retires still-`PENDING` batches to `CANCELLED` in one batch
>   write, and enqueues one `CANCEL_BATCH` per `SCHEDULED` batch that has a `request_id`; when
>   there is nothing at the provider it settles straight to `CANCELLED`.

- **6.1 ✅** `src/routes/balance.ts`: `GET /api/balance` → `{ balance, audience_count }`
  (`audience_count` = `sum(recipient_count)` − opt-outs).
- **6.2 ✅** `src/routes/campaigns.ts` + `src/services/campaigns.ts`: `POST /api/campaigns`
  validates → strips opt-outs from the audience → pre-flight balance check → one
  `env.DB.batch([...])` insert (`QUEUED` + `PENDING` rows) → `sendBatch()` in slices of ≤100 →
  `202`.
- **6.3 ✅** `GET /api/campaigns?filter=upcoming|history` (default `history`), `created_at DESC`;
  unknown filter → `400`.
- **6.4 ✅** `GET /api/campaigns/:id` → live progress + invalid count + per-batch errors; `404`
  when unknown.
- **6.5 ✅** `POST /api/campaigns/:id/cancel` per Flow B → `202`; `409` if already terminal,
  `404` if unknown.
- **6.6 ✅** `src/routes/test-sms.ts` + `src/services/test-sms.ts`: `POST /api/test-sms` sends one
  unscheduled SMS to a single UK number and **records it in History** (`is_test = 1`).
- **6.7 ✅** `src/routes/opt-outs.ts` + `src/services/opt-outs.ts`: authenticated
  `GET`/`POST /api/opt-outs` + `DELETE /api/opt-outs/:number`, and the **public**
  `POST /api/opt-out` page route (the only unauthenticated route; validated + rate-limited).
- **Verify ✅** `npm test` → **78/78 pass** (59 from Phases 4–5 + **19 in `test/phase6.test.ts`**)
  against a fake D1 + fake queue + stubbed Sendmode: `401` for anonymous `/api/*`; balance
  proxied with opt-outs subtracted; create writes the campaign + one batch per chunk and
  enqueues one `DISPATCH_BATCH` per batch (101 chunks → `[100, 1]`); opt-outs stripped before
  sending; validation `400`; insufficient-balance `400` with nothing written/queued; scheduled
  UK→UTC; list filter + ordering; detail errors; cancel (`CANCELLING`, `PENDING` retired,
  `CANCEL_BATCH` per scheduled batch, `409`/`404`, immediate `CANCELLED`); test-SMS flagged in
  History; opt-out add/list/remove + public add (JSON **and** form). `npx tsc --noEmit` (src)
  and `-p test/tsconfig.json` clean; `wrangler deploy --dry-run` bundles. Also smoke-tested the
  live Worker (`wrangler dev --local`, real seeded 8,060 audience): balance, opt-out add(list
  count 1→valid 8059), public opt-out, test-SMS (History `isTest:true`), detail, cancel
  (`CANCELLING`→`CANCELLED`), `404`s — all correct; local rows cleaned up after.

---

## Phase 7 — Queue Consumer ✅ DONE

> **Decisions made while building (recorded here, not guessed):**
> - **One handler file per message type + a shared status module.** `src/queue/dispatch.ts`
>   owns `DISPATCH_BATCH`, `src/queue/cancel.ts` owns `CANCEL_BATCH`, and
>   `src/queue/campaign-status.ts` owns the shared "is this campaign finished, and how did it
>   end?" recomputation. Keeping the recompute in one place means both paths can never disagree
>   about when a campaign settles.
> - **Handlers are pure over an injected `db` + `sendmode` config and return `ack`/`retry`.**
>   The handler does **not** touch the `Message`; `queue()` in `src/index.ts` maps the returned
>   outcome to `msg.ack()` / `msg.retry({ delaySeconds })`. That keeps every branch
>   trivially unit-testable against a fake D1 + stubbed provider (no Worker runtime).
> - **Recompute from batch rows, not optimistic counters.** Each handler re-reads the batch
>   rows and derives `completed_batches`/`failed_batches`/`invalid_count` + the terminal status
>   in one write. This is what makes retries and out-of-order delivery safe (hard rule #11):
>   D1 batch state is the only trustworthy source.
> - **Terminal rules:** any `PENDING` left ⇒ the campaign stays in flight (status untouched,
>   counters refreshed). Otherwise: any `CANCELLED` ⇒ `CANCELLED` (cancellation is sticky);
>   else any `FAILED` ⇒ `PARTIAL_FAILURE`; else any `SCHEDULED` ⇒ `SCHEDULED`; else `SENT`.
> - **Retry policy is exactly `10 * attempts` seconds** (roadmap 7.4) for `429`/`5xx`/network;
>   `400`/`401`/invalid-2xx/is_successful:false fail the batch terminally and `ack`. A thrown
>   handler error is caught and retried with the same backoff so a bug cannot silently drop a
>   send (and eventually lands in the DLQ).
> - **Cancel is idempotent and fail-safe.** A `DELETE` that the provider refuses
>   (`400`/`401`/is_successful:false) retires the batch locally anyway — the operator already
>   chose to stop, so the campaign must not hang in `CANCELLING` forever.
> - **Missing rows / unknown `type` are acked, not retried**, so a malformed or stale message
>   can never poison the queue and loop until the DLQ. Messages are processed **sequentially**
>   with a 200 ms gap (tech.md §6) to pace provider calls within the batch.

- **7.1 ✅** `src/queue/dispatch.ts`: `DISPATCH_BATCH` with the idempotency guard (non-`PENDING`
  ⇒ ack+skip) and the cancel race guard (`CANCELLING`/`CANCELLED` ⇒ batch `CANCELLED`, skip).
- **7.2 ✅** `src/queue/cancel.ts`: `CANCEL_BATCH` → `DELETE /3.0/schedule` with the bare
  `Authorization` header + JSON body; idempotent on an already-`CANCELLED` batch.
- **7.3 ✅** `queue()` in `src/index.ts` routes by `type` (unknown ⇒ ack), processes the batch
  sequentially with a 200 ms inter-message delay, and applies the returned ack/retry decision.
- **7.4 ✅** Retry policy: `msg.retry({ delaySeconds: 10 * attempts })` on `429`/`5xx`/network;
  `ack` + `FAILED` on `400`/`401` (and on `200`+`is_successful:false`).
- **7.5 ✅** `src/queue/campaign-status.ts` recomputes the campaign total after every batch and
  settles it to `SENT`/`SCHEDULED`/`PARTIAL_FAILURE`/`CANCELLED` once no `PENDING` remains.
- **Verify ✅** `npm test` → **97/97 pass** (**19 in `test/phase7.test.ts`** against a fake D1 +
  stubbed provider, driving the real `worker.queue()`): dispatch sends/schedules and persists
  `SENT`/`SCHEDULED` + `request_id` + invalid numbers; the campaign stays in flight until the
  last batch and then settles (`SENT`, `SCHEDULED`, `PARTIAL_FAILURE`); a re-delivered batch and
  a `CANCELLING` campaign never reach the provider; `5xx`/`429`/network retry with `10 * attempts`
  and leave the batch `PENDING`; `400` and `200`+`is_successful:false` fail the batch terminally;
  a test send uses its inline recipient; `CANCEL_BATCH` deletes by `request_id` and settles, but
  a still-live `SCHEDULED` sibling keeps the campaign in `CANCELLING`; unknown `type` and missing
  rows are acked. `npx tsc --noEmit` (src) and `-p test/tsconfig.json` clean.

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
