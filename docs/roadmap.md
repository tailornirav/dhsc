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

## Phase 8 — Frontend Shell (React + Vite + Tailwind) ✅ DONE

> **Decisions made while building (recorded here, not guessed):**
> - **`web/` is the Vite root; the build emits `web/dist`** — exactly what `wrangler.jsonc`
>   serves through the `ASSETS` binding (`vite build web`), so no separate deploy step exists.
>   Assets are hashed and same-origin, which keeps the Worker's strict CSP (`script-src 'self'`)
>   intact (`src/lib/hardening.ts`). Vite proxies `/api/*` to `wrangler dev` in dev, so the browser
>   stays on one origin and no CORS layer is ever needed.
> - **The estimator is a client-side *mirror*, and the mirror is tested against the server.**
>   `web/src/lib/sms.ts` duplicates `src/services/sms-segments.ts` + the budget rule in
>   `src/lib/validate.ts`; `web/src/lib/time.ts` mirrors the UK↔UTC/DST logic. The prototype wants
>   per-keystroke feedback (no server round-trip), so the only safe design is to prove the two
>   agree: `test/phase8.test.ts` asserts the client and server produce **identical** results over a
>   matrix of bodies, numbers, and schedule slots. Server validation stays authoritative.
> - **The sender ID is provisioned, so it is build config — not an operator field.** `VITE_SENDER_ID`
>   (default `DHSC`) is injected at build time and posted with every campaign/test send
>   (mission.md §8.3). A subtle warning appears in the create panel when the default is in use.
> - **Draft state lives in `App`.** One `CampaignDraft` is shared by the create form, the Test-SMS
>   modal, and the submit handler so they can never disagree about the message being sent.
> - **Polling only while something is in flight.** The Queued/History lists re-fetch every 5 s
>   *only* when a campaign is `QUEUED`/`PROCESSING`/`SCHEDULED`/`CANCELLING`, so settled views make
>   no idle traffic and a `CANCELLING`/`QUEUED` campaign self-heals without a manual refresh.
> - **Sign Out is restored** (tech.md §10 overrides prototype.md §1): the header links to the
>   Cloudflare Access logout path. The Worker never handles credentials.
> - **No new dependencies.** Icons are inline SVG, feedback is a small toast context + viewport,
>   modals are a hand-rolled accessible primitive — all built on the React/Tailwind already in
>   `devDependencies` (hard rule #1: Cloudflare only, $0).

- **8.1 ✅** `web/` scaffolded with Vite + React + Tailwind v4 (`@tailwindcss/vite`);
  `web/vite.config.ts` proxies `/api` → `http://127.0.0.1:8787` (`WORKER_DEV_ORIGIN` overridable).
  `npm run dev:web` runs the SPA; `npm run build` emits `web/dist`.
- **8.2 ✅** `Header` (sticky): brand badge + title/subtitle, Opt-Outs (count), Sync Balance,
  environment pill, Sign Out.
- **8.3 ✅** `CreditHealthMonitor`: deficit banner (only when `reserved > balance`) + Live API
  Balance / Reserved Credits / Effective Available KPI cards, fed by `/api/balance` + queued data.
- **8.4 ✅** `CreateCampaignPanel`: name (≤80), read-only All-Contacts audience with the
  `Raw − Opted-Out = Valid` strip, message + live estimator (encoding/char/segment/recipients/
  cost, suffix counted first), immediate/scheduled radio with a UK (`Europe/London`) 15-min picker,
  Test/Send/Schedule with guarded enablement.
- **8.5 ✅** `QueuedHistoryPanel`: `role="tablist"` tabs with counts, Queued cards (coverage +
  status pills, message preview, 3-metric strip, countdown, Cancel) and History cards (status pill,
  test badge, final metrics).
- **8.6 ✅** Modals: Send Test SMS, Opt-Out Blacklist, Cancel Confirmation — each a `role="dialog"`
  + `aria-modal` primitive with Escape dismissal, backdrop dismissal, focus trapping, and focus
  restore.
- **8.7 ✅** Empty states, loading spinners, disabled/guarded buttons, and a toast viewport
  (`role="status"`/`role="alert"`) plus inline field errors for validation failures.
- **Verify ✅** `npm run typecheck` + `npm run typecheck:web` + `tsc -p test/tsconfig.json` clean;
  `npm test` → **105/105 pass** (**8 in `test/phase8.test.ts`**, proving the client estimator /
  UK-number / UK-schedule helpers match the server exactly). `npm run build` emits `web/dist`
  (index.html + hashed JS/CSS). Local full-stack smoke: `wrangler dev` serves the built SPA at `/`
  (`200`) while `/api/health` is `401` unauthenticated and `/api/opt-outs` returns live data
  (`validRecipientCount: 8060`) when the Access identity header is present — anchoring the auth
  guard from Phase 5 in the new UI.

---

## Phase 9 — End-to-End Wiring ✅ DONE

> **Decisions made while building (recorded here, not guessed):**
> - **The consumer sends the producer's opt-out-stripped recipient list, not a fresh chunk
>   read.** Phase 8 proved the layers in isolation, and walking the flows end-to-end surfaced a
>   real wiring bug: campaign creation stripped opt-outs to compute the count/cost, but the
>   `DISPATCH_BATCH` message only carried `chunkIndex`, and the consumer re-read the **raw**
>   `audience_chunks` row — so an opted-out number was still sent (cost shown ≠ numbers sent, and
>   the blacklist was violated). The fix: `enqueueDispatch()` now puts the already-stripped
>   `recipients` on every message (the field the test-send path already used), and the consumer
>   prefers it. The raw-chunk read remains only as a legacy fallback. (~100 E.164 numbers is
>   ~1.5 KB, far inside the queue message limit; nothing is re-queried per batch.)
> - **Verification is a bound, reproducible full-stack walk, not a paid one.** Sending is
>   irreversible and costs real money (mission.md §6.1), so the five flows are walked in
>   `test/phase9.test.ts`, which drives the **real** HTTP app (`createApp()` request→response) and
>   the **real** queue consumer (`worker.queue()`) together against the D1/queue fakes and a
>   stubbed provider. A separate bounded `wrangler dev` smoke (`scripts/phase9-smoke.sh`) confirms
>   the built Worker boots, serves the SPA, guards `/api/*`, and reads live data — without touching
>   the live provider.
> - **Each flow asserts the observable evidence at every hop:** HTTP status/body, D1 row state,
>   the exact provider calls (send vs. schedule vs. delete, and the request body), and the
>   consumer's ack/retry decision — the same request/response evidence a manual walk produces.
> - **The cancel race is a first-class case.** Cancelling while `DISPATCH_BATCH` jobs are still
>   queued must retire them as `CANCELLED` and send nothing (hard rule #11); both the mid-flight
>   drain and the pre-dispatch race are asserted.

- **9.1 ✅** Immediate campaign: `POST /api/campaigns` → `202` `QUEUED` → two `DISPATCH_BATCH`
  jobs → `POST /3.0/send/bulk` per chunk → batches `SENT` → History shows it `SENT`.
- **9.2 ✅** Scheduled campaign: create → `POST /3.0/schedule/bulk` per chunk → batches
  `SCHEDULED` + `request_id` → campaign `SCHEDULED` → appears in the Queued view with a future
  `scheduleDate` (the card's countdown source).
- **9.3 ✅** Cancellation: `POST /api/campaigns/:id/cancel` → `202` `CANCELLING` → one
  `CANCEL_BATCH` per scheduled batch → `DELETE /3.0/schedule` per `request_id` → batches
  `CANCELLED` → campaign `CANCELLED`. Cancelling **before** dispatch enqueues 0 cancels, sends
  nothing, and settles `CANCELLED`.
- **9.4 ✅** Test SMS: `POST /api/test-sms` → normalised recipient + inline dispatch → `SENT`,
  recorded in History with `isTest: true`, one credit.
- **9.5 ✅** Opt-outs: add/remove (authenticated) and the **public** `/api/opt-out` route both move
  the valid recipient count everywhere (`/api/balance`, `/api/opt-outs`, and campaign creation),
  and a stripped number never appears in an enqueued or sent payload.
- **Verify ✅** `npm test` → **113/113 pass** (**8 in `test/phase9.test.ts`** driving the real
  HTTP app + real queue consumer through all five flows; `test/phase6.test.ts` now also asserts the
  enqueued `recipients` are opt-out-stripped). `npm run typecheck` + `npm run typecheck:web` +
  `tsc -p test/tsconfig.json` clean; `npm run build` emits `web/dist`. Local **bounded** full-stack
  run (`bash scripts/phase9-smoke.sh`, real `wrangler dev` + the seeded local D1 — 81 chunks /
  **8,060** recipients): SPA at `/` → `200`; routes serve live D1 data under the dev bypass (the
  anonymous-`401` guard is proven by `test/phase5.test.ts`, since the smoke arms the dev bypass for
  the whole session); public `POST /api/opt-out` → `200` and the count moves `8059 → 8060` across
  add/remove. **No live provider call is ever made** by the suite or the smoke.

---

## Phase 9.5 — Public Opt-Out Page (`/x`) — ISOLATED ADD-ON ✅ DONE

> **Decisions made while building (recorded here, not guessed):**
> - **`/x` is the real path.** The SMS suffix is `Stop: dhsc.uk/x` (`OPT_OUT_SUFFIX` in
>   `src/lib/validate.ts`), so the page that suffix points at is `GET /x`. No path change, so
>   `OPT_OUT_SUFFIX` and the `web/src/lib/sms.ts` mirror are untouched. Cloudflare Access leaves
>   `/x` public (configured in the dashboard, not in this repo); `/x` is outside `/api/*`, so the
>   existing guard already ignores it and `PUBLIC_API_PATHS` stays exactly `['/api/opt-out']`.
> - **The page is served two ways, kept byte-identical.** The Worker route
>   (`src/routes/opt-out-page.ts`) returns the HTML inline so `/x` works everywhere — including
>   tests, where the `ASSETS` binding is a stub with no built `web/dist`. The same bytes also ship
>   as the static asset `web/public/x.html` (Vite copies `web/public/*` into `web/dist`, served via
>   `ASSETS`). `test/phase9_5.test.ts` asserts the two are byte-identical, so they cannot drift.
> - **No duplicated opt-out logic.** The zero-JS form posts urlencoded `number` to the **existing**
>   public `POST /api/opt-out` handler (`src/routes/opt-outs.ts`, which already writes to D1 via
>   `addOptOut`). No new endpoint, no change to `opt-outs.ts`.

> **Why this phase exists:** the outbound SMS suffix is `Stop: dhsc.uk/x` (`OPT_OUT_SUFFIX` in
> `src/lib/validate.ts`), but only the **public API endpoint** `/api/opt-out` was ever built — there
> is **no rendered page** at `dhsc.uk/x` for a customer to actually visit. Phases 0–9 are complete
> and proven; this phase adds the missing customer-facing page.
>
> **Design mandate — do NOT touch the working app (hard rule for this phase):**
> - The dashboard, `/api/*` routes, auth guard, queue, provider layer, and the existing SPA are
>   **frozen**. This phase must not modify them.
> - The public page is a **standalone, zero-JS HTML page** plus **one small, self-contained Worker
>   route**. It reuses the already-tested `POST /api/opt-out` handler (which already writes to D1),
>   so **no opt-out business logic is duplicated** and no existing logic is rewritten.
> - The independent online route is `/x` — inside the same Worker and origin, so the strict CSP
>   (`script-src 'self'`, `connect-src 'self'`) and same-origin posting keep working with no CORS
>   layer. The page posts the same-origin `/api/opt-out` endpoint.

> **Decision to record before coding (ask if unclear — do not guess):**
> - **Is `/x` the real public path?** `x` is currently a placeholder in the suffix. Confirm the
>   exact path the customer will use (e.g. `/x`, `/optout`, `/stop`) and that Cloudflare Access will
>   leave it public (the Access rules are configured in the dashboard, not in this repo). If the
>   path changes, update `OPT_OUT_SUFFIX` in **both** `src/lib/validate.ts` and `web/src/lib/sms.ts`
>   in the same change (they are asserted equal by `test/phase8.test.ts`), and keep the SMS budget
>   note (160 − suffix − 1 space) in `docs/mission.md` §8.4 accurate.

- **9.5.1 ✅** Create the standalone page as a static asset, **not** part of the SPA build: e.g.
  `web/public/x.html` (Vite copies `web/public/*` into `web/dist` verbatim, and `wrangler.jsonc`
  already serves `web/dist` via the `ASSETS` binding). Self-contained HTML + inline `<style>`,
  **no JS, no build step, no framework** — so the working SPA bundle is untouched. The page is a
  simple form: a labelled `tel` input (`name="number"`, `inputmode="tel"`, autocomplete) and a
  submit button, plus a tiny inline notice that their number will no longer receive messages.
- **9.5.2 ✅** Add **one small route** so `GET /x` returns that page. Register it in `src/routes/`
  (a new, separate module — e.g. `src/routes/opt-out-page.ts` — called once from `createApp()`),
  deleting only by adding a line next to the existing `register*Routes(app)` calls. Do **not**
  edit any existing route file. The handler can either `return c.env.ASSETS.fetch(...)` for the
  static file or return the HTML string inline; keep the logic trivial (no DB access here).
- **9.5.3 ✅** Make the form post to the **existing** `POST /api/opt-out` (urlencoded) — the handler
  already accepts `number`/`phone` and already writes to D1 via `addOptOut`. **No new endpoint, no
  duplicated validation, no change to `opt-outs.ts`.** Render a friendly success/error response;
  since the page is no-JS, the plain-text/HTML response after posting is what the customer sees.
  (If a nicer UX is wanted later, a tiny progressive-enhancement script can be a follow-on — but
  it is **out of scope** for a zero-risk first cut.)
- **9.5.4 ✅** Confirm the auth carving is correct and unchanged: `/x` is **not** under `/api/*`, so
  the existing guard already ignores it; `PUBLIC_API_PATHS` stays exactly `['/api/opt-out']`.
  Do **not** widen the public API surface for this phase.
- **9.5.5 ✅** Add a focused test (`test/phase9_5.test.ts` or extend the existing pattern) feeding a
  `GET /x` request through `createApp()` (200 + contains the form) and asserting the page's post
  still lands on the same D1-writing handler (valid recipient count moves). Reuse the existing test
  fakes/helpers — no live provider call.
- **9.5.6 ✅** Update docs in the same change: `docs/tech.md` §9.2 (note the concrete `/x` page path
  and that it is static + reuses `/api/opt-out`), `docs/mission.md` §3/§8 if the path changed, and
  add a short line to the Phase 10 checklist verifying the page in production.
- **Verify ✅** `npm test` → **118/118 pass** (5 new in `test/phase9_5.test.ts`: `GET /x` → `200`
  with the form; the served bytes byte-identical to `web/public/x.html`; a form post opts a number
  out and moves the count `3 → 2`; an invalid number → `400` and nobody opted out; `/x` is
  unguarded and `PUBLIC_API_PATHS` is unchanged). `npm run typecheck` + `npm run typecheck:web` +
  `tsc -p test/tsconfig.json` clean; `npm run build` emits `web/dist` **including `x.html`**. The
  bounded local `wrangler dev` run (`bash scripts/phase9-smoke.sh`) shows the SPA at `/` → `200`
  and the public opt-out flow moving the count `8060 → 8059 → 8060`. **No live provider call.**

---

## Phase 10 — Polish, Security, Deploy

> **Scope:** this phase is mostly **verification + ops**, not new product code. The automatable
> checks are run locally (below); the parts that touch the live account — `wrangler secret put`,
> `wrangler deploy`, and a real test SMS — are deliberate ops steps. The automated suite **never
> spends money and never calls the live provider.**

- **10.1 ✅ (local)** The committed tree contains **no** `.dev.vars` (it is gitignored — see
  `.gitignore`); the local dev file holds a **dummy** key only. Moving the real key in with
  `npx wrangler secret put SENDMODE_ACCESS_KEY` is the one pre-deploy ops action (tech.md §9.3).
- **10.2 ✅** Rate limiting + security headers live in `src/lib/hardening.ts`: the public opt-out
  route is throttled per client IP (fixed-window, best-effort/per-isolate), and every response
  carries `secureHeaders` with a tight CSP (`form-action 'self'` lets the `/x` page post
  same-origin; `script-src 'self'`). Reviewed: no gaps.
- **10.2a ✅ (local)** `scripts/phase9-smoke.sh` (real `wrangler dev`) serves the SPA at `/` → `200`
  and the public opt-out flow moves the valid recipient count `8060 → 8059 → 8060`. **Production**
  wording: `GET dhsc.uk/x` → `200` with the form, **outside** Cloudflare Access; a submit opts a
  number out and moves the count.
- **10.3 ✅** `npm run build` emits `web/dist` (including `x.html`), served via the `ASSETS` binding.
- **10.4 ☐ ops** `npx wrangler deploy`; smoke-test in production with a single test SMS and a tiny
  (1-chunk) campaign.
- **10.5 ✅** Added a short `README.md` runbook (setup, quality gate, deploy, production smoke,
  rollback); docs updated to reflect reality.
- **Verify (ops):** production dashboard loads behind Cloudflare Access; anonymous `/api/*`
  blocked; `dhsc.uk/x` public; one real test SMS delivered; rollback plan documented in `README.md`.
  No automated check performs these — they run against the live account.

---

## Phase 11 — Review Fixes (security & correctness) ☐ TODO

> **Why this phase exists:** a full read-through review of the shipped Phases 0–10 found a set of
> real defects that the current test suite does not cover. They are ordered below by severity.
> Every step is small and self-contained; **11.1–11.3 are the must-fix set** (they touch money,
> compliance, or the only public route). 11.4–11.8 are correctness/polish and may be split off if
> the operator prefers.
>
> **Design mandate:** keep the changes surgical. Do **not** rewrite the queue flows, the provider
> layer, or the auth model. The three high-severity steps must each ship **with a regression test**
> (the suite is at 118 passing; it must stay green and grow).

> **Records to add to `mission.md` §8 in the same change (do not guess):**
> - **CSRF / same-origin enforcement** for the authenticated `/api/*` surface (currently assumed
>   away; becomes a resolved decision in 11.2).
> - **Scheduled-send opt-out re-check** — confirm the mission's intent: the blacklist is
>   `always stripped from every audience` (tech.md §4). 11.3 makes that true at *send* time, not
>   only at *create* time; record it as resolved.
> - **Test-send balance rule** — 11.4 decides whether `POST /api/test-sms` is exempt from the
>   balance pre-flight (hard rule #9) or not. **Resolved:** enforced, same as a campaign.

### 11.1 ✅ Public opt-out form must return an HTML confirmation, not raw JSON

> **Defect.** `web/public/x.html` (and the byte-identical string in `src/routes/opt-out-page.ts`)
> is a **zero-JS** form that posts urlencoded to `POST /api/opt-out`. That handler
> (`src/routes/opt-outs.ts`) **always** returns `c.json(...)`, so a real customer who submits the
> form sees a raw JSON blob instead of a confirmation. The primary UX path of the only public
> route is broken for real users.

> **Landed.** `POST /api/opt-out` now content-negotiates via `prefersHtml()`: a plain form post
> gets `OPT_OUT_RESULT_HTML` (200) or `OPT_OUT_ERROR_HTML` (400); JSON / `Accept: application/json`
> callers keep the unchanged JSON contract. All three documents share one style block
> (`OPT_OUT_PAGE_STYLE`), and the success text is neutral (identical whether or not the number was
> already opted out). Covered by four new tests in `test/phase9_5.test.ts` (suite now 122 green;
> `npm run typecheck` clean).

- **11.1.1 ✅** In `POST /api/opt-out`, content-negotiate the response: return a small
  self-contained **HTML confirmation page** when the request is a plain form post (no
  `Accept: application/json`, or `Content-Type: application/x-www-form-urlencoded`), and keep
  returning **JSON** for the SPA / `Accept: application/json` callers. Factor the confirmation
  HTML into a small constant (e.g. `OPT_OUT_RESULT_HTML` in `src/routes/opt-out-page.ts`) so the
  form-free page and the result page share one style block.
- **11.1.2 ✅** Keep the message **neutral** (same success text whether or not the number was
  already opted out) — do not leak membership. On an invalid number return an HTML error page
  (form-post case) / the existing `400` JSON (API case).
- **11.1.3 ✅** Extend `test/phase9_5.test.ts`: a urlencoded form post → `200` with
  `Content-Type: text/html` and the confirmation text; a JSON post → unchanged JSON; an invalid
  form post → `400` HTML error. **Verified:** `npm test` (122 total) all green;
  `npm run typecheck` clean.

### 11.2 ✅ CSRF / same-origin protection on mutating routes

> **Defect.** Every state-changing `/api/*` route is protected **only** by the Cloudflare Access
> cookie; there is **no** CSRF token and **no** `Origin`/`Referer` check anywhere (grep for
> `Origin`/`csrf`/`SameSite` returns zero hits). A cross-site request riding the Access cookie
> could trigger a real send — which spends money and cannot be undone.

> **Landed.** `isSameOrigin(c)` (`src/lib/hardening.ts`) is now the single statement of the rule
> and is wired into the `/api/*` guard in `src/index.ts` **before** auth, so it covers the whole
> group: authenticated routes *and* the public `/api/opt-out` mutation. Any unsafe method whose
> `Origin` is present and whose **host** does not match the request host gets
> `403 { error: 'cross_origin_blocked' }`; an absent `Origin` is allowed and safe methods are
> never blocked. Seven new tests in `test/phase5.test.ts` (suite now 130 green;
> `npm run typecheck` clean).

- **11.2.1 ✅** In the `/api/*` guard (`src/index.ts`, next to `requireAuth`), reject any
  **unsafe** method (`POST`/`PUT`/`PATCH`/`DELETE`) whose `Origin` header is present **and** does
  not match the request host — `403 { error: 'cross_origin_blocked' }`. Absent `Origin`
  (same-origin browsers omit it for simple requests, and tests/non-browser clients may too) is
  allowed, so this is a cheap, stateless backstop that does not break `curl`/tests.
- **11.2.2 ✅** Applied to the **public** `/api/opt-out` path too (it is also a mutation) — the
  same guard runs before the public carve-out, so one helper (`isSameOrigin(c)` in
  `src/lib/hardening.ts`) states the rule once.
- **11.2.3 ✅** Tests added in `test/phase5.test.ts`: absent-`Origin` POST → allowed; same-origin
  POST → allowed; `Origin: https://evil.example` POST → `403 cross_origin_blocked`; the same on
  `DELETE`; `GET` never blocked; the foreign origin is blocked *before* auth (anonymous ⇒ 403, not
  401); the public `/api/opt-out` mutation is blocked from a foreign origin and still reaches the
  handler from a same-origin one. **Verified:** `npm test` (130 total) all green;
  `npm run typecheck` clean.
- **11.2.4 ✅** Documented in `tech.md` §9 (new sub-point 7) that the Worker enforces same-origin
  on mutations and that it complements (does not replace) Cloudflare Access; the decision is
  recorded in `mission.md` §8 (item 9).

### 11.3 ✅ Re-check opt-outs at dispatch time (scheduled sends)

> **Defect.** `loadAudienceChunks` strips opt-outs at **create** time and freezes the stripped
> list into the queue message. For a **scheduled** campaign, a customer who opts out during the
> window before the send is **not** re-checked: `handleDispatch` deliberately never re-reads
> `opt_outs` (`src/queue/dispatch.ts`). This violates the blacklist guarantee
> (tech.md §4 "Opt-outs"; mission.md §4 item 8, "always stripped from audiences") for the
> scheduled case — a compliance issue.

- **11.3.1 ✅** In `handleDispatch` (`src/queue/dispatch.ts`), after resolving `recipients` and
  before the provider call, a fresh `loadOptOutSet` is loaded and every recipient that opted out
  after the campaign was created is dropped. One small query per batch; still far inside D1's
  per-invocation budget.
- **11.3.2 ✅** An empty list (no recipients, or all opted out since creation) reuses the existing
  `markFailed` + settle path (the batch is terminal, not retried). The raw `audience_chunks` row is
  deliberately never re-read — the blacklist is the only live input.
- **11.3.3 ✅** Regression tests added in `test/phase7.test.ts`: a scheduled campaign is created,
  a recipient opts out **after** creation, the dispatch consumer runs, and the opted-out number is
  **not** in the provider call (and a whole-list opt-out fails the batch terminally with no call).
- **11.3.4 ✅** `tech.md` Flow C step 1 and §4 "Opt-outs" now state the blacklist is applied at
  **both** create and dispatch time. **Verified:** `npm test` (132 total) all green;
  `npm run typecheck` clean; the provider stub shows the filtered recipient list.
- **Decision recorded:** `mission.md` §8 now marks the scheduled-send opt-out re-check **resolved**.

### 11.4 ✅ Test-send balance handling (decide, then align code + docs)

> **Defect.** `POST /api/campaigns` blocks when `balance < credits` (hard rule #9), but
> `POST /api/test-sms` did **not** check balance at all — a zero-balance operator could still
> fire test sends (each costs a credit). The doc said "not blocked by balance"; the hard rule
> said block.

> **Landed.** The **enforce** option was chosen: a test send is 1 credit, so it now runs the
> **same pre-flight as a campaign**. `src/routes/test-sms.ts` calls `getBalance` after
> validation and before `createTestSend`, returning `400 insufficient_balance` when the balance
> cannot cover the credit and `502 provider_error` on a provider outage — the identical shape
> `POST /api/campaigns` uses. Two new tests in `test/phase6.test.ts` cover the refusal (nothing
> written or enqueued) and the outage.

- **11.4.1 ✅** Decided and recorded in `mission.md` §8: the send is **enforced**, not exempt — a
  single credit is still a credit, and hard rule #9 (block a send the balance cannot cover)
  applies to it exactly as it does to a campaign.
- **11.4.2 ✅** Implemented in `src/routes/test-sms.ts`: the same `getBalance` pre-flight and the
  same `insufficient_balance` / `provider_error` shapes as `POST /api/campaigns`; the stale "not
  blocked by balance" comment is removed and the rule is documented in `tech.md` §5.
- **11.4.3 ✅** Tested in `test/phase6.test.ts` (zero balance → `400 insufficient_balance`, nothing
  written; provider `503` → `502 provider_error`). **Verified:** `npm test` green;
  `npm run typecheck` clean.

### 11.5 ☐ `messageBudget` must report the UCS-2 limit when the body flips encoding

> **Defect.** `messageBudget(suffix)` in `src/lib/validate.ts` derives `singleSegmentLimit` from
> the **suffix's** encoding (always GSM-7 → 160). When an emoji forces the *body* to UCS-2
> (single-segment cap 70), the "max N characters" hint shown to the operator is computed with
> the wrong limit. The outer `segments.segments > 1` check still rejects correctly, so this is a
> **misleading message**, not a correctness hole.

- **11.5.1 ☐** Make the budget reflect the **full message's** detected encoding, or pass the
  body so the hint matches what will actually be sent. Keep the pure function testable.
- **11.5.2 ☐** Mirror the change in `web/src/lib/sms.ts` (Phase 8 requires byte-for-byte
  behavioural parity; `test/phase8.test.ts` enforces it).
- **11.5.3 ☐** Add/extend a test in `test/phase4.test.ts` + `test/phase8.test.ts` for an
  emoji body. **Verify:** `npm test` green; `npm run typecheck` + `npm run typecheck:web` clean.

### 11.6 ☐ Move `DELETE /api/opt-outs/:number` off the URL path

> **Defect.** `DELETE /api/opt-outs/:number` (`src/routes/opt-outs.ts`) carries an E.164 number
> as a path segment. Phone numbers are a poor fit for path identifiers (a literal `+` and other
> characters are fragile across decoders). The modal happens to send a form that survives, but
> the contract is brittle.

- **11.6.1 ☐** Accept the number via a JSON body (`DELETE` with `{ number }`) or a query param,
  normalising through the same service. Keep the old path form working for one release if
  trivially possible, else update `web/src/api.ts` (`removeOptOut`) in the same change.
- **11.6.2 ☐** Update `test/phase6.test.ts` (6.7 family) to the new shape. **Verify:**
  `npm test` green.

### 11.7 ☐ Align `beginCancellation` with its documented pre-condition

> **Defect.** `tech.md` Flow B step 1 says cancel must "verify … `schedule_date` is still in the
> future"; `beginCancellation` (`src/services/campaigns.ts`) checks **status only**.

- **11.7.1 ☐** Either add the `schedule_date`-in-the-future guard (reject/normalise a past-but-
  still-`SCHEDULED` campaign) **or** relax the doc to match the code. Choose the behaviour that
  matches reality (the provider may still accept the `DELETE`), and record it in `tech.md`
  Flow B. **Verify:** `npm test` green.

### 11.8 ✅ Audit trail decided: identity is intentionally **not** persisted (dead code removed)

> **Gap.** `src/lib/auth.ts` resolved the Cloudflare Access identity into `c.get('identity')`,
> but the `getIdentity()` helper was exported and **no route** read it — no record of *who*
> sent a campaign, despite the identity being available. (Not a bug; a missed capability and
> dead surface.)

> **Decision (the "no" branch of 11.8.1): an audit trail is out of scope.** The `mission.md`
> §4 success criteria do not require recording the operator, reporting/analytics is a §5
> non-goal, and none of the three user roles (§3) need "who sent this". Consistent with §6.5
> (boring, readable code) the unused export was removed rather than left as speculative
> surface, and the resolution is recorded in `tech.md` §9 item 1.

- **11.8.1 ✅** Decided **no**: no `created_by` column is added. The unused `getIdentity`
  export is deleted from `src/lib/auth.ts` (the now-unused `Context` type import is trimmed
  with it). The `identity` context variable and `ContextVariableMap` typing remain — that is
  what `requireAuth` sets and what the 401 behaviour depends on. `tech.md` §9 item 1 now states
  that identity is resolved for the request but **intentionally not persisted**.
- **11.8.2 ✅** No migration needed (no column added), so the forward-only migration rule is
  untouched. `test/phase5.test.ts` no longer imports `getIdentity`; its "identity is attached
  to the context" test now asserts the same guarantee via `c.get("identity")` directly, so
  coverage is unchanged. **Verified:** `npm test` green; `npm run typecheck` clean.

### Phase 11 — Verify (automatable)

- `npm test` → existing 118 **plus** the new regression tests, all green.
- `npm run typecheck` + `npm run typecheck:web` + `npx tsc --noEmit -p test/tsconfig.json` clean.
- `npm run build` → `web/dist` unchanged in shape (still includes `x.html`).
- `bash scripts/phase9-smoke.sh` still shows the public opt-out flow moving the count.
- **No live provider call and no spend at any point.**

---

## Phase 12 — Manual recipient list ("send to specific numbers") ☐ TODO

> **Why this phase exists:** today a campaign can only target **all contacts** (`audience_chunks`
> minus opt-outs). Operators sometimes need to send a one-off blast to a **few numbers they paste
> in** (e.g. a handful of regulars, a test group, a small event list). The mission was updated for
> this (mission.md §8.10, success criterion §4.2).
>
> **Design mandate — minimal disruption. This is an *audience source*, not a new pipeline.**
> Reuse the existing create → queue → dispatch path **unchanged**: the pasted numbers become the
> batch `recipients[]` we already send on the queue message (the test-send path already enqueues
> an inline number this way). Therefore: **no new endpoint, no new table, no migration, no new
> status, no new queue message type, no new provider call shape.** The entire surface change is
> one optional `recipients` string on `POST /api/campaigns` plus a UI toggle — anything larger is
> out of scope for this phase.
>
> **Safety is the point.** Operators cannot be trusted to paste clean data, so the list gets the
> **same tight checks as every other audience**: `normalizeUkMobile` per entry (the authoritative
> UK-mobile rule — accepts `+447…`, `447…`, `07…`, and spaced/dashed forms), reject the whole
> request on any invalid line (never silently drop), de-duplicate, and opt-out-strip. The existing
> `empty_audience`, `insufficient_balance`, and single-segment message rules apply unchanged.
>
> **Records to add to `mission.md` §8 in the same change (do not guess):** the manual recipient
> decision (§8.10) and the §5 non-goal clarification (pasting a one-off list is in scope;
> persisting/editing a contact list is not).

### 12.1 ✅ Server: accept an optional manual `recipients` list on create

> **Nano-step, no schema change.** Add the audience *source* branch only; every downstream step
> of Flow A stays byte-identical.

- **12.1.1 ✅** In `src/lib/validate.ts`, add a pure parser — e.g.
  `parseManualRecipients(raw: string): { numbers: string[]; invalid: string[] }` — that splits
  input on newlines, commas, and semicolons (plus surrounding whitespace), runs each entry
  through `normalizeUkMobile`, de-duplicates the valid set (order-preserving), and returns the
  invalid raw entries **as-given** so the API can name them in the error. Keep it pure so both
  the route and the web mirror can share the rule. **Do not** invent a second number regex —
  `normalizeUkMobile` is the one source of truth (mission.md §6.5, tech.md §9.4).
- **12.1.2 ✅** In `src/routes/campaigns.ts` (`toCampaignInput` + the `POST /api/campaigns`
  handler), read `recipients` as an optional string. When present and non-blank:
    1. parse it with `parseManualRecipients`; if `invalid.length > 0` return
       `400 validation_failed` with one issue per bad entry
       (`{ field: 'recipients', code: 'invalid_number', message: '…is not a valid UK mobile.' }`)
       — **refuse, never silently drop** (mirrors the campaign invalid-input rule).
    2. strip opt-outs via the already-loaded `loadOptOutSet`, then chunk the survivors into
       ≤100 groups (`chunkArray`, the existing helper) to build the same `PlannedBatch[]` the
       default path builds (`chunkIndex` = 0,1,2… in order; no `audience_chunks` row is read).
    3. if the stripped list is empty → `400 empty_audience` (same shape as today).
  When `recipients` is absent/blank, keep the **current** default path exactly.
- **12.1.3 ✅** Leave `insertCampaign`, `enqueueDispatch`, the queue consumer, and
  `src/services/campaigns.ts` **untouched** — they already take `PlannedBatch[]` with explicit
  `recipients`. Confirm by reading them; this step should add **zero** code there.
- **Verify:** `npm test` green (existing 132 all pass unchanged) + `npm run typecheck` clean.

### 12.2 ✅ Server tests: the manual list is validated, deduped, and opt-out-stripped

- **12.2.1 ✅** In `test/phase6.test.ts` (Flow A family), add cases driving the **real HTTP app**:
    - a valid multi-line list (mix of `+447…`, `447…`, `07… 700 900 077` spellings) → `202`,
      and the enqueued `DISPATCH_BATCH` messages carry exactly the **normalised** numbers and
      the chunks are ≤100 per message;
    - a list with a duplicate → the duplicate is sent **once**;
    - a list containing an opt-out number → that number is **absent** from the queue payload;
    - a list with **one bad entry** (e.g. `+441234`, a landline, `hello`) → `400
      validation_failed`, **no** `campaigns`/`campaign_batches` rows written, **nothing**
      enqueued (assert the stub provider queue saw no `DISPATCH_BATCH`);
    - a list where **every** number is opted out → `400 empty_audience`;
    - `insufficient_balance` still refuses a manual send just like a default one.
- **12.2.2 ✅** Add a pure unit test for `parseManualRecipients` in `test/phase4.test.ts`
  (separators, whitespace, dedupe, invalid capture).
- **Verify:** `npm test` green (new count > 132); `npm run typecheck` + `npx tsc --noEmit -p
  test/tsconfig.json` clean. **No live provider call.**

### 12.3 ☐ Client: mirror the parser + extend the API call

- **12.3.1 ☐** Add `parseManualRecipients` to `web/src/lib/sms.ts` (or a small new
  `web/src/lib/recipients.ts`) as a **byte-for-byte behavioural mirror** of the server function,
  exactly like the existing `sms.ts`/`time.ts` mirrors (tech.md §10). Reuse the client's
  `normalizeUkMobile` equivalent if one exists; if the client has none, mirror it too.
- **12.3.2 ☐** Add `recipients?: string` to the `createCampaign` input in `web/src/api.ts`
  (pass-through only; omit the key entirely when the mode is "all contacts").
- **12.3.3 ☐** Extend `test/phase8.test.ts` with the mirror-parity matrix for the new parser
  (same inputs → identical `{ numbers, invalid }` on both sides).
- **Verify:** `npm test` green; `npm run typecheck:web` clean.

### 12.4 ☐ UI: audience-source toggle + paste box in `CreateCampaignPanel`

- **12.4.1 ☐** Add an audience-source control to the **Target Audience** block (prototype.md
  §5.1): two options — `All Contacts` (default, today's read-only strip) and `Specific Numbers`
  (a `role="radiogroup"`/radio pair, matching the existing Delivery-Schedule radios for style).
  When `Specific Numbers` is selected, reveal a `<textarea>` (labelled, `font-mono`, placeholder
  like `+447700900077, 07700900078` — one per line or comma-separated) and swap the sanitization
  strip for the pasted-list counts: `Entered → −Duplicate → −Opted-Out → = Valid`.
- **12.4.2 ☐** Extend `CampaignDraft` with the new field (e.g. `recipients: string` and an
  `audienceSource: 'all' | 'manual'`); thread it through `App.tsx`'s `EMPTY_DRAFT` and
  `submitCampaign` (send `recipients` only when `audienceSource === 'manual'`). The live estimator
  and the cost/affordability guard must use the **manual** valid count when that source is active
  (it drives `Recipients` and `Total Est. Cost`).
- **12.4.3 ☐** Extend the guards so `Send`/`Schedule` are disabled when `Specific Numbers` is
  selected and the parsed list has **zero valid** entries or any invalid entry — surface the
  invalid lines inline via the existing `FieldIssues`/`FieldError` path (add `recipients` to
  `FieldIssues`). Client validation stays **convenience only**; the server remains authoritative.
- **12.4.4 ☐** Update `prototype.md` §5.1 and §1 (item 2) to describe the toggle so the UI
  reference is not stale. **Verify:** `npm run typecheck:web` clean; `npm run build` succeeds;
  manual dev-backend walk (`npm run dev` + `npm run dev:web`) shows the toggle, the strip, the
  disabled-guard behaviour, and a `202` on a small valid list. **No live provider call on
  submit** — use the local seeded D1 / dev values.

### Phase 12 — Verify (automatable)

- `npm test` → existing 132 **plus** the Phase 12 tests, all green.
- `npm run typecheck` + `npm run typecheck:web` + `npx tsc --noEmit -p test/tsconfig.json` clean.
- `npm run build` → `web/dist` still builds and includes `x.html`.
- **No migration, no schema drift** (`npx drizzle-kit generate` emits **no** new migration).
- **No live provider call and no spend at any point.**

---

## Backlog / Later (only if the mission expands)

- Consume Sendmode **webhooks** for real delivery status (deferred decision, `mission.md` §8.7).
- Admin UI to re-seed the audience from a new CSV without a local script.
- Per-campaign analytics (delivered/failed over time).
- Scheduled campaign auto-retry if a batch hits a transient outage near the lead time.
