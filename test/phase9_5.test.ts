/**
 * Phase 9.5 verification — Public Opt-Out Page (`/x`).
 *
 *   npm test        # runs everything under test/
 *
 * Phase 9.5 is an isolated add-on: it adds the customer-facing page behind the SMS suffix
 * `Stop: dhsc.uk/x` (`OPT_OUT_SUFFIX`). It must NOT touch the working app, so this suite pins
 * the two facts the phase promises and guards the "frozen" contract around them:
 *
 *   1. `GET /x` (through the **real** `createApp()`) returns `200` and the opt-out form, and the
 *      served HTML is byte-identical to the committed static copy `web/public/x.html` (so the
 *      static asset the build emits and the Worker response can never drift).
 *   2. The page's `urlencoded` form post lands on the **existing** `POST /api/opt-out` handler —
 *      it opts a number out (moves the D1-backed valid recipient count) with **no auth**, and no
 *      new endpoint or duplicated validation is introduced.
 *   3. The auth carving is unchanged: `/x` is not under `/api/*`, so the guard ignores it, and
 *      `PUBLIC_API_PATHS` is still exactly `["/api/opt-out"]` (the public API surface is not
 *      widened).
 *
 * The double for the provider lives in `test/helpers/fakes.ts`. No live provider call is made.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, PUBLIC_API_PATHS, type Env } from "../src/index.js";
import { OPT_OUT_PAGE_HTML } from "../src/routes/opt-out-page.js";
import { FakeD1, FakeQueue, stubProvider } from "./helpers/fakes.js";

/** Three clean recipients across two chunks (mirrors the other phase suites). */
function seededDb(): FakeD1 {
  const db = new FakeD1();
  db.seedAudience([["+447700900001", "+447700900002"], ["+447700900003"]]);
  return db;
}

/** A dev-authenticated env backed by the given fakes (mirrors `test/phase9.test.ts`). */
function makeEnv(db: FakeD1, queue: FakeQueue): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: queue as unknown as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
    DEV_AUTH_BYPASS: "true",
  };
}

/** A public (unauthenticated) env — the page posts here, so the dev identity must not apply. */
function publicEnv(db: FakeD1, queue: FakeQueue): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    SMS_QUEUE: queue as unknown as Queue,
    SENDMODE_ACCESS_KEY: "test-key",
  };
}

// =======================================================================================
// 9.5.1 / 9.5.2 — the page renders at GET /x and matches the static asset
// =======================================================================================

test("9.5 GET /x serves the opt-out page (200, HTML, contains the form)", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    // No identity and no ASSETS build: the page is served as a plain string, so it must work
    // even when the static-asset binding is absent (as it is in tests).
    const res = await app.request("/x", {}, publicEnv(db, queue));

    assert.equal(res.status, 200, "GET /x should be 200");
    assert.match(
      res.headers.get("content-type") ?? "",
      /text\/html/,
      "GET /x should be served as HTML",
    );

    const html = await res.text();
    // The essentials a customer needs: a labelled tel input named `number`, a submit button,
    // and a form that posts to the existing public endpoint.
    assert.ok(html.includes('action="/api/opt-out"'), "form posts to the public opt-out endpoint");
    assert.ok(html.includes('method="post"'), "form uses POST");
    assert.ok(html.includes('name="number"'), "input is named `number` (the handler's field)");
    assert.ok(html.includes('type="tel"'), "input is a `tel` field");
    assert.ok(html.includes('inputmode="tel"'), "input opts into the phone keypad");
    assert.ok(/autocomplete="tel"/.test(html), "input enables tel autocomplete");
    assert.ok(html.includes("<button"), "form has a submit button");
    // The notice: the number will no longer receive messages.
    assert.match(html, /no.*receive|not receive|Stop receiving/i, "page states the opt-out effect");
  } finally {
    provider.restore();
  }
});

test("9.5 the served page is byte-identical to the committed static asset web/public/x.html", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const served = await (await app.request("/x", {}, publicEnv(db, queue))).text();

    // The static copy is what `npm run build` copies into `web/dist` and `wrangler.jsonc` serves
    // via ASSETS; the Worker response is what tests and any non-asset environment see. They must
    // not drift.
    // `test/` and `web/` are siblings under the project root.
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const staticHtml = readFileSync(join(projectRoot, "web", "public", "x.html"), "utf8");
    assert.equal(served, staticHtml, "GET /x body must equal web/public/x.html");
    assert.equal(served, OPT_OUT_PAGE_HTML, "exported constant is the single source of truth");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 9.5.3 — the page's form post reuses the existing /api/opt-out (D1 write), no auth
// =======================================================================================

test("9.5 the page's urlencoded form post opts out via the existing handler and moves the count", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const env = makeEnv(db, queue); // authenticated reads (for /api/opt-outs) use this
    const pub = publicEnv(db, queue); // the page's POST is unauthenticated

    // Baseline: 3 valid recipients, no opt-outs.
    const before = (await (await app.request("/api/opt-outs", {}, env)).json()) as {
      count: number;
      validRecipientCount: number;
    };
    assert.deepEqual([before.count, before.validRecipientCount], [0, 3]);

    // Exactly what the browser sends from the form: urlencoded `number`, no auth identity.
    const posted = await app.request(
      "/api/opt-out",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `number=${encodeURIComponent("07700900002")}`,
      },
      pub,
    );
    assert.equal(posted.status, 200, "the form post succeeds without auth");

    // The write is the existing D1-backed one: normalised + stored, and the count drops.
    assert.equal(db.optOuts.length, 1);
    assert.equal(db.optOuts[0]?.mobile_number, "+447700900002");

    const after = (await (await app.request("/api/opt-outs", {}, env)).json()) as {
      count: number;
      validRecipientCount: number;
    };
    assert.deepEqual([after.count, after.validRecipientCount], [1, 2], "count moves 3 → 2");
  } finally {
    provider.restore();
  }
});

test("9.5 an invalid number from the form is rejected (400) and opts nobody out", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();
    const res = await app.request(
      "/api/opt-out",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "number=12345",
      },
      publicEnv(db, queue),
    );
    assert.equal(res.status, 400, "a non-UK number is rejected by the existing handler");
    assert.equal(db.optOuts.length, 0, "nothing is written for an invalid number");
  } finally {
    provider.restore();
  }
});

// =======================================================================================
// 9.5.4 — the auth carving is unchanged (isolated add-on: no public API widening)
// =======================================================================================

test("9.5 /x is not guarded and PUBLIC_API_PATHS is unchanged", async () => {
  const db = seededDb();
  const queue = new FakeQueue();
  const provider = stubProvider(1000);

  try {
    const app = createApp();

    // `/x` is outside `/api/*`, so even an anonymous request gets the page (not a 401).
    const page = await app.request("/x", {}, publicEnv(db, queue));
    assert.equal(page.status, 200, "the public page is reachable without auth");

    // The public API surface did not grow: the only carve-out is still the opt-out endpoint.
    assert.deepEqual([...PUBLIC_API_PATHS], ["/api/opt-out"]);

    // ...and a sibling `/api/*` route is still guarded for an anonymous caller (guard intact).
    const health = await app.request("/api/health", {}, publicEnv(db, queue));
    assert.equal(health.status, 401, "other /api/* routes stay behind the auth guard");
  } finally {
    provider.restore();
  }
});
