# DHSC — Dilli Haat SMS Campaign

A login-protected web dashboard that lets a UK restaurant send **bulk SMS campaigns**
(immediate or scheduled) to its customer list via the **Sendmode API**, running entirely on
**Cloudflare Workers + D1 + Queues at $0/month**.

- **Host:** `dhsc.uk` — password-based **Cloudflare Access** in front of the dashboard and all
  `/api/*`. The **only** public route is the opt-out page at `/x`.
- **Audience:** a static, pre-chunked CSV seeded into D1 (`audience_chunks`); not edited in-app.
  A campaign targets either **all contacts** (default) or a **manually pasted list of UK numbers**
  for a one-off send (validated, deduped, opt-out-stripped, never stored).

Start with **[`agent.md`](agent.md)** for the project map and the hard rules, then
**[`docs/tech.md`](docs/tech.md)** (stack, schema, API, security) and
**[`docs/mission.md`](docs/mission.md)** (scope, decisions). Build order and status live in
**[`docs/roadmap.md`](docs/roadmap.md)**.

---

## Setup (local)

```bash
npm install

# Apply schema migrations and seed the audience into local D1 (one-time)
npx wrangler d1 migrations apply sms-campaigns-db --local
npx tsx scripts/seed-audience.ts

npm run dev          # Worker (API + queue) on http://127.0.0.1:8787
npm run dev:web      # Vite dev server for web/ (proxies /api -> wrangler dev)
```

Local dev values live in a gitignored **`.dev.vars`** (`SENDMODE_ACCESS_KEY=<dummy>`,
optionally `DEV_AUTH_BYPASS="true"` to skip the Access gate locally). **Never put a live
Sendmode key in `.dev.vars`.**

## Quality gate

```bash
npm test                          # unit + integration (real app + real queue consumer, stub provider)
npm run typecheck                 # src
npm run typecheck:web             # web/
npx tsc --noEmit -p test/tsconfig.json
npm run build                     # web/ -> web/dist (served via the ASSETS binding)
bash scripts/phase9-smoke.sh      # bounded full-stack smoke (real wrangler dev, no live provider)
```

The automated suite **never calls the live provider and never spends money**.

## Deploy

```bash
# 1. Put the live provider key in the Worker (never in code / never committed)
npx wrangler secret put SENDMODE_ACCESS_KEY

# 2. Apply migrations to the remote D1
npx wrangler d1 migrations apply sms-campaigns-db --remote

# 3. Build + deploy
npm run deploy        # = npm run build && wrangler deploy
```

Before the first production send, confirm the Cloudflare Access rules leave **only `/x`** public.

## Production smoke (spends a little — do it deliberately)

1. Load `https://dhsc.uk` **behind** Access; confirm anonymous access is **blocked** (`/api/*` → 401).
2. `GET https://dhsc.uk/x` → `200` with the opt-out form, **outside** Access.
3. Send **one** test SMS (`POST /api/test-sms` via the dashboard) and confirm delivery.
4. Create a **tiny (1-chunk)** campaign and watch it move `QUEUED → SENT` in History.

## Rollback

- **Bad Worker code:** redeploy the previous good version from the Cloudflare dashboard
  (*Workers & Pages → the Worker → Deployments → Rollback*), or `git checkout <good-sha> && npm run deploy`.
- **Bad migration:** D1 migrations are forward-only in this repo; restore by shipping a new
  migration that reverses the change (do **not** hand-edit the remote DB).
- **Runaway campaign:** cancel it (`POST /api/campaigns/:id/cancel`) — this deletes each scheduled
  provider job by `request_id`; already-**SENT** batches cannot be recalled (hard rule: SMS cannot
  be undone).

## Layout

| Path | What |
| :--- | :--- |
| `src/index.ts` | Worker entry: Hono app + the queue consumer + the Cron `scheduled()` reconcile. |
| `src/routes/` | HTTP routes (balance, campaigns, test-sms, opt-outs, public `/x` page). |
| `src/services/` | Domain logic (audience, opt-outs, Sendmode client, segment maths). |
| `src/queue/` | Queue message types + dispatch/cancel handlers + the Cron reconcile. |
| `src/lib/` | Auth, hardening, validation, UK-time helpers. |
| `src/db/` | Drizzle schema + migrations. |
| `web/` | React + Vite SPA (builds to `web/dist`). `web/public/x.html` is the static opt-out page. |
| `scripts/` | `seed-audience.ts` (CSV → `audience_chunks`), `phase9-smoke.sh` (bounded smoke). |
| `docs/` | `mission.md`, `tech.md` (authoritative), `roadmap.md`, `sms-api.md`, `prototype.md`. |
