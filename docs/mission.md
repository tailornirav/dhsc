# Mission — DHSC (Dilli Haat SMS Campaign)

> **Read this first.** This document explains *why* the system exists. For *how* it is
> built, read `tech.md`. For *what to build next*, read `roadmap.md`. `agent.md` (repo
> root) tells you where everything lives.

---

## 1. One-Sentence Mission

Give a **UK-based restaurant** a simple, login-protected web dashboard to send **bulk SMS
campaigns** to its own customer list — immediately or scheduled — at **zero hosting cost**,
with no third-party SMS UI and no data leaving the operator's Cloudflare account.

---

## 2. The Problem We Are Solving

The restaurant (client) currently relies on a raw SMS provider dashboard (Sendmode) to run
promotional blasts. That workflow is painful and error-prone:

- No clean way to schedule a campaign once and trust it will actually go out.
- Easy to accidentally spend a large amount of money (each SMS costs real credits) with no
  cost preview before pressing send.
- No single view of "what is scheduled", "what already went out", and "how much credit is
  left".
- No safe way to stop a campaign that was scheduled by mistake.
- No way to keep a customer opt-out list respected automatically.
- Sharing raw API credentials with non-technical staff.

DHSC wraps that provider API in a **purpose-built, guarded dashboard** that is safe for a
non-technical restaurant operator to use day to day.

---

## 3. Who Uses It

| User | Goal | Access |
| :--- | :--- | :--- |
| **Restaurant operator** (primary) | Draft, schedule, monitor, and cancel SMS campaigns; watch credit balance; manage opt-outs. | Must be authenticated (Cloudflare Access / Zero Trust). |
| **Restaurant customer** | Reply/click to opt out of future campaigns. | *No login.* Only the opt-out path is public. |
| **Developer / AI agent** | Build and maintain the system. | Repo + docs; never holds production secrets in code. |

Anything not required by these three users is out of scope.

---

## 4. What Success Looks Like (definition of done)

The mission is achieved when a logged-in operator can, from one page, without touching the
Sendmode dashboard or any terminal:

1. **See credit health** — live provider balance, credits reserved by queued campaigns, and
   net available credits, with a clear warning if a queued campaign is under-funded.
2. **Create a campaign** — name it, write a message, see a *live* character/segment/cost
   estimate, and target **all contacts** (opt-outs already stripped).
3. **Send immediately** — dispatched in chunks through a background queue, with per-batch
   status visible.
4. **Schedule a campaign** — pick a UK `Europe/London` date/time on 15-minute slots, at
   least 20 minutes ahead; the app stores it as UTC.
5. **Send a test SMS** — to a single UK number, unscheduled, to verify copy before a blast.
6. **Watch progress** — Queued and History views reflecting real D1 state, not hardcoded
   numbers.
7. **Cancel a scheduled campaign** — stops every not-yet-sent batch and releases reserved
   credits.
8. **Manage opt-outs** — add/remove numbers that are always stripped from audiences.

…all of it running on **one Cloudflare account at $0/month** with **no unauthenticated
surface except opt-out**.

---

## 5. Explicit Non-Goals (for now)

These are deliberately **out of scope**; do not build them unless the mission changes:

- Multi-tenant support (one restaurant, one account).
- A CRM / contact editor / import pipeline. The CSV is static; it is seeded once (only valid
  UK mobiles are kept, dirty rows are dropped), not managed in-app.
- Rich delivery analytics, per-recipient delivery receipts, or provider webhooks. (The API
  supports webhooks, but consuming them is **deferred** — terminal state is provider
  acceptance. See `mission.md` §8.)
- Payment, billing, or credit top-up. Credits are bought in the Sendmode dashboard.
- Any second database, cache, or queue provider (no Upstash/Redis/Kafka). Cloudflare only.
- Native mobile apps. The UI is a responsive web app.
- Two-way SMS conversations.

---

## 6. Product Principles (how we make decisions)

1. **Safety over speed.** Spending money is irreversible; sending is irreversible. When in
   doubt, block the action and explain why.
2. **Zero surprise cost.** The operator always sees the credit cost *before* confirming.
3. **One vendor, one deploy, $0.** Cloudflare Workers + D1 + Queues only. If a feature needs
   a new paid dependency, it needs a mission-level justification first.
4. **Login is the default; opt-out is the only door.** No API route, queue action, or
   dashboard view is reachable by an anonymous user except the opt-out flow.
5. **Boring, readable code.** Simple over clever. It must be maintainable by an AI agent
   following `roadmap.md` step by step, and reviewable by a human.
6. **The docs are the source of truth.** If code and docs disagree, either fix the code or
   update the docs in the same change.

---

## 7. Constraints That Shape the Mission

These are not preferences — the design *must* respect them (details in `tech.md`):

- **Cloudflare Free plan:** 50 sub-requests per HTTP request, 10 ms CPU per invocation,
  D1's 50-queries-per-invocation and 100-bound-parameters-per-statement limits, and Queues'
  ~10,000 ops/day budget. This is *why* bulk sends fan out via a queue instead of a loop.
- **UK carriers:** `sender_id` max 11 alphanumeric characters; sender IDs must be
  pre-registered with the provider for UK delivery.
- **UK time:** the operator thinks in `Europe/London` (GMT/BST), the API requires UTC on
  15-minute boundaries.
- **Sendmode API v3.0 quirks:** bare `Authorization: {ACCESS_KEY}` (no `Bearer`), JSON body
  required even on `DELETE`, 100 recipients max per bulk call.

---

## 8. Resolved Decisions

These are now **settled facts**. Treat them as requirements, not preferences.

1. **Auth:** the app is hosted at **`dhsc.uk`** (custom domain). Auth is **simple
   password-based `Cloudflare Access` (Zero Trust)** in front of the dashboard and all
   `/api/*`. No additional custom login layer.
2. **Opt-out:** a **public web page** where a customer enters their phone number to opt out.
   This is the *only* unauthenticated route.
3. **Sender ID:** already provisioned with the provider. Treat it as a fixed configured
   value (not something the operator invents per campaign); still validate length/charset.
4. **Message length:** **160 characters is a hard maximum** for GSM-7. Any opt-out/stop
   suffix (e.g. `Stop: dhsc.uk/x`) is **appended first**, and the *remaining* character budget
   is what the operator may write. Emojis/non-GSM characters flip the message to UCS-2, which
   changes the budget and doubles cost — the estimator must show this live.
5. **Audience:** the CSV has **8,093 data rows**; after dropping the 33 dirty rows the
   **8,060 clean** UK mobiles seed **81 `audience_chunks` rows** (80×100 + 1×60). Chunk size
   stays 100 (matches the provider's 100-cap).
6. **Test SMS:** **recorded in History** like any other campaign (marked as a test send), so
   the operator can see what was tested.
7. **Webhooks:** *deferred / undecided.* For now the terminal state is **"accepted by the
   provider"** (`request_id` returned). We do **not** consume delivery webhooks yet. See
   backlog in `roadmap.md` if this changes.
8. **Concurrency/rate limits:** use the **defaults** (`max_batch_size: 5`,
   `max_concurrency: 2`, `max_retries: 5`). Sendmode publishes no rate limit we must throttle
   below; if Cloudflare or the provider surfaces throttling in practice, revisit these values.

### Still genuinely open

- **Opt-out pubsub detail:** does the public opt-out page simply stop future campaigns, or
  should it also be reflected in any "delivered" reporting? (Assumed: stop future sends only.)
- **Access JWT verification:** do we verify the `Cf-Access-Jwt-Assertion` signature in the
  Worker, or trust the header once Access is confirmed to be the only ingress? (Assumed:
  trust the header, verify later if exposed beyond Access.)

### Open pending Phase 11 (see `roadmap.md` Phase 11 — resolve when each step lands)

- **CSRF / same-origin enforcement (11.2):** the authenticated `/api/*` surface is currently
  protected by the Cloudflare Access cookie alone. Decision needed: enforce same-origin on
  unsafe methods in the Worker (recommended) and/or rely on the Access cookie's `SameSite`
  attribute. Until resolved, treat cross-site mutation as an unmitigated risk.
- **Scheduled-send opt-out re-check (11.3):** the blacklist is documented as *always* stripped
  from every audience, but it is currently applied only at **create** time. Decision to confirm:
  re-check `opt_outs` at **dispatch** time for scheduled campaigns so the guarantee holds at
  send time too (recommended — it is the compliant reading).
- **Test-send balance rule (11.4):** hard rule #9 says block a send when the estimate exceeds
  credit, but `POST /api/test-sms` is currently exempt. Decide whether a test send (1 credit)
  stays exempt or gets the same pre-flight as a campaign.
