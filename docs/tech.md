# Tech Stack — DHSC (Dilli Haat SMS Campaign)

> **Read alongside** `mission.md` (why) and `roadmap.md` (order of work).
> This file is the **engineering contract**: the stack, the schema, the API surface, the
> queue flows, and the hard constraints. If the code and this file disagree, stop and fix
> one of them before continuing.

---

## 1. Stack Overview (one Cloudflare Worker, $0/month)

Everything ships as **one Cloudflare Worker** (API + static assets) backed by **one D1
database** and **one Queues pair**. No other infrastructure.

| Layer | Choice | Notes |
| :--- | :--- | :--- |
| Language | **TypeScript** | Strict mode. Runs on Workers runtime (V8 isolates, Web APIs). |
| API framework | **Hono** | Lightweight router. Keep it thin — routing + validation only. |
| Frontend | **React + Vite** → built to static assets | Served by the same Worker via the `ASSETS` binding. Tailwind CSS for styling. |
| Database | **Cloudflare D1** (SQLite) | Never auto-pauses. Accessed via binding `env.DB`. |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | Typed queries and SQL migrations against D1. Preferred over raw SQL. |
| Background jobs | **Cloudflare Queues** | Producer binding `SMS_QUEUE`; consumer on queue `sms-campaign-jobs`; DLQ `sms-campaign-dlq`. |
| Auth | **Cloudflare Access (Zero Trust)** | Login wall in front of everything except the opt-out path. |
| SMS provider | **Sendmode REST API v3.0** | See `docs/sms-api.md`. This is the authoritative API reference. |
| Secrets | `wrangler secret put` (+ `.dev.vars` locally) | Never in `wrangler.jsonc`, never committed. |

**Do not add** a second database, cache, queue, or auth provider. No Redis/Upstash, no Kafka,
no CSV parser at runtime, no `moment`/`bcrypt`.

---

## 2. Repository Layout (target)

```
dhsc/
├── agent.md                # agent orientation + hard rules (root)
├── docs/
│   ├── mission.md          # why
│   ├── tech.md             # this file — how
│   ├── roadmap.md          # ordered nano-steps
│   ├── prototype.md        # UI reference (directional, not binding)
│   └── sms-api.md          # Sendmode API v3.0 contract
├── wrangler.jsonc          # Worker, assets, D1, Queues bindings
├── drizzle.config.ts       # drizzle-kit config (dialect: sqlite, driver: d1-http)
├── package.json
├── scripts/
│   └── seed-audience.ts    # one-time local chunker: CSV -> audience_chunks
├── src/                    # Worker (API + queue consumer)
│   ├── index.ts            # Hono app + queue() handler export
│   ├── db/
│   │   ├── schema.ts       # Drizzle table definitions
│   │   └── migrations/     # drizzle-kit output, applied via wrangler d1 migrations
│   ├── routes/             # /api/* handlers
│   ├── services/           # sendmode.ts, campaigns.ts, balance.ts, sms-segments.ts
│   ├── queue/              # consumer dispatch + per-job handlers
│   └── lib/                # auth middleware, validation, errors, time (UK<->UTC)
└── web/                    # React + Vite frontend
    ├── src/ …
    └── dist/               # build output served as static assets
```

---

## 3. `wrangler.jsonc` (bindings contract)

```jsonc
{
  "name": "uk-sms-campaigns",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "assets": { "directory": "./web/dist", "binding": "ASSETS" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "sms-campaigns-db",
      "database_id": "<YOUR_D1_ID>",
      "migrations_dir": "src/db/migrations"
    }
  ],
  "queues": {
    "producers": [{ "binding": "SMS_QUEUE", "queue": "sms-campaign-jobs" }],
    "consumers": [{
      "queue": "sms-campaign-jobs",
      "max_batch_size": 5,
      "max_batch_timeout": 2,
      "max_concurrency": 2,
      "max_retries": 5,
      "dead_letter_queue": "sms-campaign-dlq"
    }]
  }
}
```

`max_batch_size: 5` means each consumer invocation makes **at most 5 provider fetches** —
comfortably under the 50-sub-request ceiling — while throttling gently against provider rate
limits.

`migrations_dir` points wrangler at the directory **drizzle-kit** emits into
(`src/db/migrations`); without it wrangler looks in `./migrations` and finds nothing.

Secrets (set with `wrangler secret put`, never committed):

- `SENDMODE_ACCESS_KEY` — Sendmode API access key.

Local-dev-only auth bypass (never set in production): `DEV_AUTH_BYPASS="true"` (optionally
`DEV_AUTH_EMAIL`) in a gitignored `.dev.vars` lets `wrangler dev` / tests pass the auth guard
without Cloudflare Access. See `src/lib/auth.ts` and Phase 5 in `roadmap.md`.

---

## 4. Data Model (D1 / SQLite)

The audience CSV is **static** (seeded once, never edited in-app). Its real shape is
`docs/data.csv` with header `customer_name,phone_e164,visit_count` and **8,093 data rows**. It is
**not** perfectly clean: **8,060** rows are clean UK mobiles (`+44` + `7` + 9 digits), while **33**
are dirty (32 with a duplicated `44`, e.g. `+44447…`; 1 structurally corrupt). The seeder keeps
only the **8,060 clean rows** and drops the rest (logged, never guessed). Do **not** store
thousands of contact rows and chunk at runtime. Instead, a one-time local Node script
(`scripts/seed-audience.ts`) chunks the clean numbers into rows of **100** (→ **81 rows**:
80 full chunks of 100 plus 1 of 60) and seeds `audience_chunks`.

The canonical schema (Drizzle `sqliteTable` definitions mirror these; drizzle-kit emits the
migrations):

```sql
-- Pre-chunked static audience (81 rows: 80×100 + 1×60 for 8,060 clean numbers)
CREATE TABLE audience_chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_index     INTEGER NOT NULL UNIQUE,
  recipient_count INTEGER NOT NULL,
  mobile_numbers_json TEXT NOT NULL      -- JSON array of up to 100 E.164 strings
);

-- Campaign metadata (drives Queued & History views)
CREATE TABLE campaigns (
  id                 TEXT PRIMARY KEY,   -- UUID
  name               TEXT NOT NULL,
  sender_id          TEXT NOT NULL,      -- provisioned sender ID; <=11 chars, no <>
  message            TEXT NOT NULL,      -- operator text; suffix appended first; <=160 (GSM-7)
  mode               TEXT NOT NULL,      -- 'IMMEDIATE' | 'SCHEDULED'
  schedule_date      TEXT,               -- ISO 8601 UTC ('2026-12-01T14:00:00Z') or NULL
  status             TEXT NOT NULL,      -- see §5 status machine
  total_recipients   INTEGER NOT NULL,
  total_batches      INTEGER NOT NULL,
  completed_batches  INTEGER NOT NULL DEFAULT 0,
  failed_batches     INTEGER NOT NULL DEFAULT 0,
  invalid_count      INTEGER NOT NULL DEFAULT 0,
  estimated_credits  INTEGER NOT NULL,
  is_test            INTEGER NOT NULL DEFAULT 0,  -- 1 for a single test send (shown in History)
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- Per-batch provider tracking (enables safe retries & cancellation)
CREATE TABLE campaign_batches (
  id                   TEXT PRIMARY KEY, -- UUID
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id),
  chunk_index          INTEGER NOT NULL,
  status               TEXT NOT NULL,    -- 'PENDING'|'SENT'|'SCHEDULED'|'CANCELLED'|'FAILED'
  sendmode_request_id  TEXT,             -- returned by Sendmode; needed for DELETE /3.0/schedule
  invalid_numbers_json TEXT,             -- JSON array from Sendmode response
  error_message        TEXT,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_batches_campaign ON campaign_batches(campaign_id, status);
```

**Opt-outs:** the brief requires an opt-out blacklist that is always stripped from audiences.
Add an `opt_outs` table (at minimum: `mobile_number` unique + `created_at`) in the migration
phase. Resolved: opt-out is a **public web page**, so the table is written by an
unauthenticated route (validated + rate-limited) and read by audience computation.

**Test-send flag:** `campaigns.is_test` (added in Phase 2) exists so a single test SMS can be
**recorded in History and labelled as a test** (mission.md §8.6 / roadmap 6.6); the rest of a
test row is shaped like any other 1-recipient campaign.

### Status machine (do not invent new values)

- `campaigns.status`: `QUEUED` → `PROCESSING` → (`SENT` | `SCHEDULED` | `PARTIAL_FAILURE`);
  plus `SCHEDULED` (future), and the cancellation branch `CANCELLING` → `CANCELLED`.
- `campaign_batches.status`: `PENDING` → (`SENT` | `SCHEDULED` | `FAILED` | `CANCELLED`).

---

## 5. Web API Surface (5 endpoints, all behind auth)

| Method | Endpoint | Behavior |
| :--- | :--- | :--- |
| `GET` | `/api/balance` | Proxy `GET /3.0/balance`; return `{ balance, audience_count }`. |
| `POST` | `/api/campaigns` | Validate, check balance, create campaign + batch rows, enqueue, `202 Accepted`. |
| `GET` | `/api/campaigns` | List campaigns by `created_at DESC`; support `?filter=upcoming` \| `history`. |
| `GET` | `/api/campaigns/:id` | Live progress: `completed_batches/total_batches`, invalid count, batch errors. |
| `POST` | `/api/campaigns/:id/cancel` | Mark `CANCELLING`, enqueue cancel jobs for scheduled batches. |

Plus:
- `POST /api/test-sms` — single, unscheduled test SMS to one UK number (used by the Test SMS
  modal). **Test sends are recorded in History** (flagged as a test send).
- `GET /api/opt-outs` / `POST /api/opt-outs` / `DELETE /api/opt-outs/:number` — authenticated
  opt-out management (count shown in the header).
- **Public opt-out route** (no auth) — a page at `dhsc.uk` where a customer submits their
  phone number. This is the **only** unauthenticated route.

### Auth rule (non-negotiable)

Every `/api/*` route except the public opt-out route must be **rejected when unauthenticated**.
Enforce this in **one middleware** applied to the `/api/*` group so no new route can forget
it. Queue handlers trust their payloads only because only authenticated requests can enqueue.

---

## 6. Queue Flows

### Consumer entrypoint

`src/index.ts` exports both Hono `fetch` and a `queue(batch, env, ctx)` handler. Each
invocation processes up to 5 messages sequentially (or with gentle parallelism) with a small
delay (~200 ms) between provider calls. Every message is `{ type: 'DISPATCH_BATCH' | 'CANCEL_BATCH', campaignId, batchId, ... }`.

### Flow A — Create campaign (`POST /api/campaigns`)

1. **Validate:** `name` non-empty; `sender_id` = the provisioned value (validate ≤11 chars, no
   `<`/`>`); `message` — opt-out suffix is appended first, then the operator's text must fit
   the remaining budget with **160 chars as the hard max** in GSM-7 (fewer when UCS-2); no
   `<`/`>`; if scheduled — valid ISO 8601 UTC ending `Z`, minutes ∈ {00,15,30,45},
   seconds `:00`, and **≥ 20 min in the future** (5-minute buffer over the provider's 15-min
   minimum so the last batch never arrives late).
2. **Pre-flight balance:** compute segments (160 GSM-7 / 70 UCS-2 if emojis or non-GSM chars)
   × `total_recipients`; `GET /3.0/balance`; reject `400` if balance < estimate.
3. **Single D1 batch write:** insert the `campaigns` row (`QUEUED`) and all `campaign_batches`
   rows (`PENDING`) via `env.DB.batch([...])` — counts as **1 query**.
4. **Enqueue in 2 calls:** `SMS_QUEUE.sendBatch()` accepts ≤ 100 messages/call; slice the
   batch jobs into chunks of 100 → two calls. Payload:
   `{ type: 'DISPATCH_BATCH', campaignId, batchId, chunkIndex }`.
5. Return **`202 Accepted`** (target: < 1 s).

### Flow B — Cancel campaign (`POST /api/campaigns/:id/cancel`)

Cancellation runs through the **same queue** because Sendmode needs one `DELETE /3.0/schedule`
per `request_id`.

1. Verify campaign is `QUEUED`/`SCHEDULED` and `schedule_date` is still in the future.
2. Set `campaigns.status = 'CANCELLING'`.
3. Mark still-`PENDING` batches `CANCELLED` in D1 (they never reached the provider).
4. Fetch `SCHEDULED` batches with a `sendmode_request_id`; enqueue
   `{ type: 'CANCEL_BATCH', campaignId, batchId, requestId }` in chunks of ≤ 100.
5. Return `202 Accepted`; the UI polls until `status === 'CANCELLED'`.

### Flow C — Queue consumer

**`DISPATCH_BATCH`:**
1. Load campaign, batch, and `audience_chunk` from D1.
2. **Idempotency/race guard:** if `batch.status !== 'PENDING'` → `ack`, skip. If
   `campaign.status ∈ {'CANCELLING','CANCELLED'}` → mark batch `CANCELLED`, `ack`, skip
   (stops sending if the operator cancelled mid-queue).
3. Call provider — `POST /3.0/send/bulk` (IMMEDIATE) or `POST /3.0/schedule/bulk`
   (SCHEDULED) with header `Authorization: ${env.SENDMODE_ACCESS_KEY}` (**no `Bearer`**),
   `tags: [campaign.name]`, `customer_id: batch.id`.
4. **Error handling:** `200` + `is_successful: true` → save `request_id` &
   `invalid_mobile_numbers`, set `SENT`/`SCHEDULED`, `ack`. `400`/`401` (non-retryable) →
   mark `FAILED` + `error_message`, `ack`. Network error / `429` / `5xx` →
   `msg.retry({ delaySeconds: 10 * msg.attempts })`.
5. Recompute campaign totals; when zero `PENDING` remain, set campaign to `SENT`,
   `SCHEDULED`, or `PARTIAL_FAILURE`.

**`CANCEL_BATCH`:**
1. If already `CANCELLED` → `ack`, skip.
2. `DELETE https://sms-rest.sendmode.dev/3.0/schedule` with `Content-Type: application/json`,
   `Authorization: ${env.SENDMODE_ACCESS_KEY}`, body `{"request_id": requestId}`.
3. `200` + `is_successful` → mark `CANCELLED`, `ack`; retry on transient `5xx`/`429`.
4. When zero `SCHEDULED`/`PENDING` remain, set campaign `CANCELLED`.

---

## 7. Sendmode Integration Cheat-Sheet (from `docs/sms-api.md`)

- **Base URL:** `https://sms-rest.sendmode.dev` (all paths `/3.0/...`). ⚠️ The prompt's prose
  once wrote `sendmode.dev` without `sms-rest`; the API doc is authoritative.
- **Auth header:** `Authorization: {ACCESS_KEY}` — **never** `Bearer `.
- `GET /3.0/balance` → `{ balance, is_successful, error_message, accept_date }`.
- `POST /3.0/send/bulk` → `{ sender_id, message, mobile_numbers[≤100], customer_id?, tags? }`
  → `{ invalid_mobile_numbers, request_id, is_successful, error_message, accept_date }`.
- `POST /3.0/schedule/bulk` → same body + `schedule_date` (ISO UTC, 15-min slots, ≥15 min
  future) → same response shape; `request_id` is what cancellation needs.
- `DELETE /3.0/schedule` → body `{ request_id }`; returns
  `{ is_successful, error_message, accept_date }`.
- `sender_id`: 1–15 chars, regex `[^<>]*`. **This account's sender ID is provisioned** —
  treat it as a fixed configured value (not operator-typed per campaign). **UK practice: cap
  at 11 alphanumeric chars** and validate.
- `message`: 1–1224 chars, regex `[^<>]*`. **Product rule: 160 chars is the hard max** (GSM-7)
  with the opt-out suffix counted first; emojis → UCS-2 changes the budget.

---

## 8. Hard Constraints Checklist (non-negotiable)

- [ ] **50 sub-requests/request:** never loop over batches with `fetch()` inside an HTTP
      route. Every fan-out (send/schedule/cancel) goes through `SMS_QUEUE.sendBatch()`
      (≤ 100 messages per call).
- [ ] **10 ms CPU/invocation:** keep the Worker light. No `moment`, no `bcrypt`, no runtime
      CSV parser. Use `env.DB.batch()` for multi-row writes and `crypto.subtle` for any
      hashing/cookies.
- [ ] **D1 100-parameter limit:** never build one giant multi-row `INSERT` with hundreds of
      `?` placeholders. Use `env.DB.batch()` with separate prepared statements.
- [ ] **Bearerless auth & DELETE quirk:** bare `Authorization`, and a JSON body with
      `Content-Type: application/json` on `DELETE /3.0/schedule`.
- [ ] **UK time & 15-min slots:** the picker is labelled **UK Time (`Europe/London`)**, minutes
      restricted to `00/15/30/45`, ≥20 min lead time, converted to ISO 8601 UTC (`Z`) before
      POSTing.
- [ ] **UK sender ID & 160-char cap:** sender ID is provisioned (validate ≤11 alphanumeric
      chars, no `<`/`>`); enforce **160 characters as a hard maximum** (GSM-7), counting the
      opt-out suffix first; show a live **character + credit estimator** so the operator sees
      instantly when an emoji flips GSM-7 → UCS-2 and can double the bill.
- [ ] **Auth everywhere:** one middleware guards all `/api/*`; only the opt-out path is public.

---

## 9. Security Model (simple, not exotic)

1. **Login wall (Cloudflare Access, password-based Zero Trust):** all traffic to the
   dashboard (`dhsc.uk`) and `/api/*` is authenticated. Cloudflare Access handles the
   identity; the Worker **trusts** the Access identity header (`Cf-Access-Authenticated-User-Email`
   / `Cf-Access-Jwt-Assertion`) on authenticated requests. The guard is **one middleware**
   (`src/lib/auth.ts`) applied to the whole `/api/*` group in `src/index.ts`; it is
   **deny-by-default** with an explicit public carve-out list (`PUBLIC_API_PATHS`). A local
   dev bypass (`DEV_AUTH_BYPASS === "true"`) is opt-in and defaults off so the live gate is
   never opened by accident. JWT **signature** verification is deliberately **not** done in
   the Worker (mission.md §8, still-open) because Access is the only ingress.
2. **Opt-out exception:** the only unauthenticated route — a single-purpose **public page**
   (`dhsc.uk` path) where a customer submits their phone number. Scope it tightly (validated
   input, rate-limited, no data exposure beyond acknowledging the opt-out). Its API path
   (`/api/opt-out`) is the sole entry in `PUBLIC_API_PATHS`; it skips auth but is
   **rate-limited per client IP** (fixed-window in-memory limiter, best-effort/per-isolate —
   see `src/lib/hardening.ts`).
3. **Secrets:** provider key only via `wrangler secret put`; `.dev.vars` is gitignored. The
   committed `.dev.vars` must never contain a **live production key** — the value currently
   present looks live, so treat moving it to `wrangler secret` as a pre-deploy task
   (`roadmap.md` 10.1).
4. **Input validation:** server-side validation is authoritative (the UI is convenience only).
   Reject `<`/`>` per API rules; validate E.164 UK numbers; reject past/aligned-wrong times.
5. **Payload safety:** queue messages are only enqueued by authenticated routes, so consumer
   handlers can trust their schema — but still re-check DB state (idempotency guards).
6. **No data leakage:** error responses return safe messages, never stack traces or secrets.

---

## 10. Frontend Notes (see `prototype.md` for the full UI reference)

The prototype is **directional**. Key deltas already decided by the mission:

- **Auth is back** (the prototype removed it): the dashboard is visible only to a logged-in
  user; add a Sign Out affordance.
- **Default all contacts** (no audience dropdown), with a sanitization strip
  (`Raw → −Opted-Out → = Valid`).
- **Live estimator** bound to real state: encoding (GSM-7/UCS-2), characters, segments,
  recipients, total cost — and account for the opt-out suffix length if it is appended.
- **UK date/time picker** labelled `Europe/London`, 15-min slots, ≥20 min lead, sent as UTC.
- **Queued/History** reflect real D1 data with relative dispatch countdowns; no hardcoded
  numbers. Balance/reserved/available KPIs come from `/api/balance` + campaign data.
- Accessibility: `role="dialog"`/`aria-modal` on modals, tab roles on Queued/History, labelled
  inputs.

---

## 11. Local Development & Commands (expected)

```bash
npm install
npm run dev            # vite dev server for web/ (proxying /api to wrangler dev)
npx wrangler dev       # Worker (API + queue) locally
npx drizzle-kit generate           # emit migration SQL from schema.ts
npx wrangler d1 migrations apply sms-campaigns-db --local
npx wrangler d1 migrations apply sms-campaigns-db --remote
npx tsx scripts/seed-audience.ts   # chunk CSV -> audience_chunks (local, one-time)
npm run build          # build web/ -> web/dist
npx wrangler deploy
```

Secrets in dev: put `SENDMODE_ACCESS_KEY=...` in `.dev.vars` (gitignored).

**drizzle-kit credentials (optional).** Day-to-day schema work needs no credentials:
`npx drizzle-kit generate` only reads `schema.ts`, and `wrangler d1 migrations apply` applies
the emitted SQL. Only `drizzle-kit push` / `drizzle-kit migrate` (an alternative to the wrangler
runner — not this project's source of truth) need d1-http credentials. To enable them, copy
`.env.example` → `.env` (gitignored) and fill in `CLOUDFLARE_ACCOUNT_ID`
(`npx wrangler whoami`), `CLOUDFLARE_DATABASE_ID` (`npx wrangler d1 list`), and
`CLOUDFLARE_D1_TOKEN` (an API token with **D1 Edit**; secret — never commit).
