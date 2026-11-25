/**
 * Phase 8 verification — the dashboard's client-side estimators must agree **exactly** with the
 * Worker's authoritative logic. The prototype (prototype.md §8) requires the estimator to update
 * on every keystroke; the risk is that the browser-side copy drifts from the server rules, so the
 * operator sees a "valid" message the server then rejects (or vice versa).
 *
 * These tests import the real **web** pure-logic modules (`web/src/lib/sms.ts`,
 * `web/src/lib/time.ts`) and the real server modules, then assert they produce identical results
 * across a matrix of inputs. That is the strongest guarantee we can give without a DOM test runner,
 * and it is exactly the invariant the UI's form guards depend on.
 *
 *   npm test           # runs everything under test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Server (authoritative) logic.
import {
  analyzeSegments as serverAnalyze,
  estimatedCredits as serverCredits,
} from "../src/services/sms-segments.js";
import {
  messageBudget as serverBudget,
  normalizeUkMobile as serverNormalize,
  parseManualRecipients as serverParseManualRecipients,
  validateCampaign,
} from "../src/lib/validate.js";
import { validateUkSchedule } from "../src/lib/uk-time.js";

// Client (mirror) logic.
import {
  analyzeSegments as clientAnalyze,
  estimatedCredits as clientCredits,
  messageBudget as clientBudget,
  normalizeUkMobile as clientNormalize,
  parseManualRecipients as clientParseManualRecipients,
} from "../web/src/lib/sms.js";
import {
  describeScheduleProblem,
  localValueToUtcIso,
  nextSlotLocalValue,
} from "../web/src/lib/time.js";

/** A spread of bodies: GSM-7 basics, extension chars, UCS-2 flips, boundaries, emoji. */
const SAMPLE_BODIES = [
  "",
  "Hi",
  "Weekend tasting menu — book now!",
  "Café special: crème brûlée €12",
  "Curly “quotes” and an en-dash – test",
  "😀 emoji flips us to UCS-2",
  "a".repeat(159),
  "a".repeat(160),
  "a".repeat(161),
  "{extension} chars cost two septets",
  "0123456789".repeat(16),
];

test("8.x client analyzeSegments matches the server for every sample body", () => {
  for (const body of SAMPLE_BODIES) {
    const client = clientAnalyze(body);
    const server = serverAnalyze(body);
    assert.deepEqual(client, server, `mismatch for: ${JSON.stringify(body.slice(0, 24))}`);
  }
});

test("8.x client messageBudget matches the server exactly", () => {
  assert.deepEqual(clientBudget(), serverBudget());
});

test("8.x client estimatedCredits matches the server for a matrix", () => {
  for (const segments of [0, 1, 2, 3]) {
    for (const recipients of [0, 1, 60, 100, 8060]) {
      assert.equal(
        clientCredits(segments, recipients),
        serverCredits(segments, recipients),
        `segments=${segments} recipients=${recipients}`,
      );
    }
  }
});

test("8.x client UK-mobile normalisation matches the server", () => {
  const inputs = [
    "+447700900077",
    "447700900077",
    "07700900077",
    "07 700 900 077",
    "0770-0900-077",
    "(0770) 900077",
    "+44 7700 900077",
    "+44770090007", // too short
    "+4477009000778", // too long
    "+441234567890", // landline
    "not-a-number",
    "",
  ];
  for (const input of inputs) {
    assert.equal(clientNormalize(input), serverNormalize(input), `input: ${input}`);
  }
});

test("8.x/12.3 client parseManualRecipients matches the server for a matrix", () => {
  const inputs = [
    "",
    "  \n , ; \t",
    "+447700900077",
    "  +447700900077 \n 07700900078, 447700900079 ;\t0770-0900-080\n\n",
    "+447700900077, 07700900077\n+447700900078, +447700900077",
    "hello, +441234, +447700900077\n not a number ",
    "+44 7700 900077; (0770) 900077",
    "07700900077",
    "+353871234567",
    "+44770090007",
    ";;;\n\n,,,",
  ];
  for (const raw of inputs) {
    assert.deepEqual(
      clientParseManualRecipients(raw),
      serverParseManualRecipients(raw),
      `input: ${JSON.stringify(raw)}`,
    );
  }
});

test("8.x client schedule pre-check agrees with the server for valid slots", () => {
  // A fixed 'now' so the test is deterministic. Both the client helper and the server accept an
  // injected clock; here we only need a wall-clock that is comfortably in the future.
  const now = new Date("2026-06-01T10:00:00Z");

  // A date-time-local string whose UK wall clock is well past the lead time.
  const localValue = "2026-06-02T14:15";

  // The client helper must find no problem…
  assert.equal(describeScheduleProblem(localValue, now), null);

  // …and its UTC conversion must match what the server's validator produces.
  const clientUtc = localValueToUtcIso(localValue);
  const serverResult = validateUkSchedule(localValue.replace("T", "T"), now);
  assert.equal(serverResult.ok, true);
  if (serverResult.ok) {
    assert.equal(clientUtc, serverResult.utcIso);
  }
});

test("8.x client pre-check rejects the same bad slots the server rejects", () => {
  const now = new Date("2026-06-01T10:00:00Z");
  const bad = [
    "2026-06-02T14:07", // not a 15-min slot
    "2026-06-02T14:15:30", // seconds not zero
    "2026-06-01T10:10", // too soon (< 20 min lead)
  ];
  for (const value of bad) {
    const server = validateUkSchedule(value, now);
    assert.equal(server.ok, false, `expected server to reject ${value}`);
    assert.notEqual(describeScheduleProblem(value, now), null, `expected client to flag ${value}`);
  }
});

test("8.x nextSlotLocalValue produces a slot the server accepts", () => {
  const now = new Date("2026-06-01T10:00:00Z");
  const suggested = nextSlotLocalValue(now);
  // The client should consider its own suggestion valid…
  assert.equal(describeScheduleProblem(suggested, now), null);
  // …and so should the server.
  const server = validateUkSchedule(suggested, now);
  assert.equal(server.ok, true);
});

test("8.x the full-message estimator agrees with the server for a valid draft", () => {
  // The estimator builds `body + " " + suffix`; the server validates the same assembly. For a
  // body with room to spare both must conclude a single segment and identical credit cost.
  const recipients = 8060;
  const body = "Weekend tasting menu is here";
  const suffix = "Stop: dhsc.uk/x";
  const full = `${body} ${suffix}`;

  const clientInfo = clientAnalyze(full);
  assert.equal(clientInfo.segments, 1);

  const validated = validateCampaign(
    { name: "Promo", senderId: "DHSC", message: body, mode: "IMMEDIATE" },
    { now: new Date("2026-06-01T10:00:00Z"), suffix },
  );
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(validated.value.fullMessage, full);
    assert.equal(validated.value.segments.segments, clientInfo.segments);
    assert.equal(
      clientCredits(clientInfo.segments, recipients),
      serverCredits(validated.value.segments.segments, recipients),
    );
  }
});
