# agent.md — DHSC Agent Orientation & Hard Rules

> **You are an AI coding agent working in this repository.** Read this file first, every
> session. It tells you what the project is, where everything lives, which docs are
> authoritative, and the rules you must not break.

---

## 1. What this project is (30 seconds)

DHSC ("Dilli Haat SMS Campaign") is a **login-protected web dashboard** that lets a **UK
restaurant** send **bulk SMS campaigns** (immediately or scheduled) to its customer list via
the **Sendmode API**, running entirely on **Cloudflare Workers + D1 + Queues at $0/month**.

The customer list is a **static CSV** (seeded once into a pre-chunked table); it is **not**
edited in the app. The file is **not** perfectly clean — the seeder keeps only valid UK mobiles
and drops the rest (see below).

---

## 2. Where to look (source map)

| Question | Read this |
| :--- | :--- |
| **Why** does this exist? Scope, non-goals, users, open questions. | `docs/mission.md` |
| **How** is it built? Stack, schema, API surface, queue flows, hard constraints, security. | `docs/tech.md` |
| **What do I build next?** Ordered nano-steps with verify steps. | `docs/roadmap.md` |
| UI reference (directional, not binding). | `docs/prototype.md` |
| Provider API contract (authoritative for Sendmode). | `docs/sms-api.md` |
| Worker config (Worker, assets, D1, Queues bindings). | `wrangler.jsonc` |
| Drizzle schema + migrations. | `src/db/schema.ts`, `src/db/migrations/` |
| One-time CSV → `audience_chunks` seeder (keeps only clean `+447…` rows). | `scripts/seed-audience.ts` |
| Worker app + queue consumer. | `src/index.ts`, `src/routes/`, `src/services/`, `src/queue/`, `src/lib/` |
| React + Vite frontend. | `web/` (builds to `web/dist`, served via the `ASSETS` binding) |

**Authority order when docs conflict:** `docs/sms-api.md` (external contract) >
`docs/tech.md` > `docs/mission.md` > `docs/prototype.md` (UI reference only). If code and docs
disagree, fix both in the same change.

> Note: the repo may still be bootstrapping — paths like `src/`, `web/`, and
> `scripts/seed-audience.ts` are **targets** until the relevant `roadmap.md` phase creates
> them.

---

## 3. How to work (process)

1. **Read** `docs/mission.md` and `docs/tech.md` before writing code.
2. **Pick the next uncompleted step** from `docs/roadmap.md` — one nano-step at a time, in
   order. Do not skip ahead or batch phases.
3. **Ask, don't guess**, when a step is marked **[Q]/[BLOCKER]** or the intent is unclear.
   Record resolved answers in the docs.
4. **Implement** the step with the smallest change that satisfies it, matching existing style.
5. **Verify** using the step's **Verify** line. Report the exact command you ran and what it
   output. Never claim a check passed unless you ran it.
6. **Update docs** in the same change if behavior/contracts changed.

---

## 4. Hard rules (non-negotiable)

These exist because the whole design is calibrated to Cloudflare Free limits and a real,
irreversible spend. Breaking one silently breaks the product.

1. **Cloudflare only, $0.** No second DB/cache/queue/auth provider. No Redis/Upstash/Kafka.
2. **Auth by default.** One middleware guards **all** `/api/*`. The **only** public route is
   the opt-out path. New routes must not bypass this.
3. **Never loop provider calls in an HTTP request.** All fan-out goes through
   `SMS_QUEUE.sendBatch()` (≤ 100 messages per call) — the Free plan allows only 50
   sub-requests/request.
4. **Respect D1 limits.** ≤ 50 queries/invocation and ≤ 100 bound params/statement. Use
   `env.DB.batch([...])` with separate prepared statements — never one giant multi-row INSERT.
5. **Keep the Worker light.** ≤ 10 ms CPU. No `moment`, no `bcrypt`, no runtime CSV parser.
   Use `crypto.subtle` for any hashing.
6. **Sendmode auth is bare.** `Authorization: {ACCESS_KEY}` — **never** `Bearer `. Always send
   `Content-Type: application/json` and a JSON body on `DELETE /3.0/schedule`.
   Base URL is `https://sms-rest.sendmode.dev`.
7. **UK time & 15-min slots.** Picker labelled `Europe/London`; minutes ∈ `00/15/30/45`, `:00`
   seconds; ≥ 20 min lead time; convert to ISO 8601 UTC (`Z`) before POSTing.
8. **UK sender ID.** Cap at **11** alphanumeric chars in UI validation (provider allows 15).
   Reject `<`/`>` in `sender_id` and `message`.
9. **Show cost before spending.** Live character/segment/credit estimator; block send when the
   estimate exceeds available credit.
10. **Secrets never in code.** Use `wrangler secret put` / gitignored `.dev.vars`. Never commit
    keys to `wrangler.jsonc` or any committed file.
11. **Idempotency matters.** Queue handlers must re-check DB state (skip if already
    sent/cancelled) because messages can be retried or delivered out of order.

---

## 5. Quick facts

- **Host:** `dhsc.uk` — password-based **Cloudflare Access (Zero Trust)** in front of the
  dashboard and all `/api/*`. The **only** public route is the opt-out page.
- **Provider base URL:** `https://sms-rest.sendmode.dev` (paths `/3.0/...`).
- **Bulk recipient cap:** 100 numbers per provider call → matches **audience chunk size 100**
  (**81** chunks for the **8,060**-clean-number CSV: 80×100 + 1×60).
- **Message limit:** **160 chars is the hard max** (GSM-7); the opt-out suffix is appended
  first and counts against it. Emojis → UCS-2 changes the budget and cost.
- **Queue tuning:** `max_batch_size: 5`, `max_concurrency: 2`, `max_retries: 5`, DLQ
  `sms-campaign-dlq`.
- **Statuses:** campaign `QUEUED|PROCESSING|SENT|SCHEDULED|CANCELLING|CANCELLED|PARTIAL_FAILURE`;
  batch `PENDING|SENT|SCHEDULED|CANCELLED|FAILED`. Do not invent new values.
- **Timezone:** operators think `Europe/London`; storage/API is UTC.

---

## 6. Commands (expected)

```bash
npm install
npx wrangler dev                        # Worker (API + queue) locally
npm run dev                             # Vite dev server for web/ (proxy /api)
npx drizzle-kit generate                # emit migration SQL
npx wrangler d1 migrations apply sms-campaigns-db --local
npx wrangler d1 migrations apply sms-campaigns-db --remote
npx tsx scripts/seed-audience.ts        # chunk CSV -> audience_chunks
npm run build                           # build web/ -> web/dist
npx wrangler deploy
```

---

## 7. When in doubt

Open the relevant **resolved decision** in `docs/mission.md` §8; for anything still genuinely
open there, ask rather than guess. It is always acceptable to pause and ask rather than build
the wrong thing — sending SMS spends real money and cannot be undone.
