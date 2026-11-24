/**
 * Phase 4 verification — unit tests for the Sendmode service layer and the pure lib
 * helpers, run with Node's built-in test runner (`node --test`) via `tsx` (no extra
 * dependency; hard rule #5 keeps the toolchain minimal).
 *
 *   npm test           # runs everything under test/
 *
 * Coverage matches roadmap Phase 4 "Verify": segment math incl. emoji → UCS-2, UK→UTC
 * conversion across a BST and a GMT date, validation edge cases, and the provider request
 * shapes/auth quirks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeSegments,
  detectEncoding,
  estimatedCredits,
  singleSegmentLimit,
} from "../src/services/sms-segments.js";

import {
  cancelSchedule,
  getBalance,
  scheduleBulk,
  sendBulk,
  SENDMODE_BASE_URL,
  type SendmodeConfig,
} from "../src/services/sendmode.js";

import {
  formatUkDateTime,
  isQuarterAligned,
  parseUkLocal,
  toUtcIso,
  ukLocalToUtc,
  validateUkSchedule,
} from "../src/lib/uk-time.js";

import {
  buildFullMessage,
  campaignCredits,
  isValidUkMobile,
  messageBudget,
  normalizeUkMobile,
  OPT_OUT_SUFFIX,
  validateCampaign,
} from "../src/lib/validate.js";

// =======================================================================================
// sms-segments.ts
// =======================================================================================

test("detectEncoding: ASCII is GSM-7, extension char is GSM-7, emoji/Cyrillic is UCS-2", () => {
  assert.equal(detectEncoding("Hello world"), "GSM-7");
  assert.equal(detectEncoding("£€~^{}[]|\\"), "GSM-7"); // all in the GSM-7 extension table
  assert.equal(detectEncoding("😀"), "UCS-2");
  assert.equal(detectEncoding("Привет"), "UCS-2");
  assert.equal(detectEncoding("café — naïve"), "UCS-2"); // em-dash is NOT GSM-7
});

test("analyzeSegments: empty message has zero segments", () => {
  const info = analyzeSegments("");
  assert.equal(info.segments, 0);
  assert.equal(info.length, 0);
  assert.equal(info.isEmpty, true);
});

test("analyzeSegments: GSM-7 single segment boundary at exactly 160", () => {
  assert.equal(analyzeSegments("a".repeat(160)).segments, 1);
  assert.equal(analyzeSegments("a".repeat(160)).length, 160);
});

test("analyzeSegments: GSM-7 rolls to 2 segments at 161 chars", () => {
  const info = analyzeSegments("a".repeat(161));
  assert.equal(info.segments, 2);
  assert.equal(info.length, 161);
  // Concatenated GSM-7 holds 153 per part: 161 needs ceil(161/153) = 2.
});

test("analyzeSegments: GSM-7 multipart uses the 153 rule (306 = 2, 307 = 3)", () => {
  assert.equal(analyzeSegments("a".repeat(306)).segments, 2);
  assert.equal(analyzeSegments("a".repeat(307)).segments, 3);
});

test("analyzeSegments: GSM-7 extension characters cost two septets", () => {
  // `€` is sent as ESC + `e` → 2 septets.
  assert.equal(analyzeSegments("€").length, 2);
  assert.equal(analyzeSegments("€".repeat(80)).length, 160);
  assert.equal(analyzeSegments("€".repeat(80)).segments, 1);
  assert.equal(analyzeSegments("€".repeat(81)).length, 162);
  assert.equal(analyzeSegments("€".repeat(81)).segments, 2);
});

test("analyzeSegments: emoji flips the whole message to UCS-2 (70/67 thresholds)", () => {
  const info = analyzeSegments("😀");
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.length, 2); // surrogate pair = 2 UTF-16 code units
  assert.equal(info.segments, 1);
});

test("analyzeSegments: UCS-2 single segment boundary at 70 code units", () => {
  // 70 UCS-2 units: 35 emoji (35 * 2 units) fits one segment.
  assert.equal(analyzeSegments("😀".repeat(35)).length, 70);
  assert.equal(analyzeSegments("😀".repeat(35)).segments, 1);
  // 71 units => 2 segments.
  assert.equal(analyzeSegments("a" + "😀".repeat(35)).length, 71);
  assert.equal(analyzeSegments("a" + "😀".repeat(35)).segments, 2);
});

test("analyzeSegments: UCS-2 multipart uses the 67 rule", () => {
  assert.equal(analyzeSegments("😀".repeat(67)).length, 134);
  assert.equal(analyzeSegments("😀".repeat(67)).segments, 2);
  assert.equal(analyzeSegments("😀".repeat(68)).length, 136);
  assert.equal(analyzeSegments("😀".repeat(68)).segments, 3);
});

test("singleSegmentLimit reports 160 (GSM-7) / 70 (UCS-2)", () => {
  assert.equal(singleSegmentLimit("GSM-7"), 160);
  assert.equal(singleSegmentLimit("UCS-2"), 70);
});

test("estimatedCredits multiplies segments by recipients", () => {
  assert.equal(estimatedCredits(1, 8060), 8060);
  assert.equal(estimatedCredits(2, 8060), 16120);
  assert.equal(estimatedCredits(0, 100), 0);
  assert.equal(estimatedCredits(1.9, 10.9), 10); // floored, defensively
  assert.equal(estimatedCredits(-1, 10), 0);
});

// =======================================================================================
// uk-time.ts
// =======================================================================================

test("ukLocalToUtc: winter (GMT) date keeps the same wall-clock hour in UTC", () => {
  const utc = ukLocalToUtc({ year: 2026, month: 1, day: 15, hour: 14, minute: 0, second: 0 });
  assert.equal(toUtcIso(utc), "2026-01-15T14:00:00Z");
});

test("ukLocalToUtc: summer (BST) date shifts one hour earlier in UTC", () => {
  const utc = ukLocalToUtc({ year: 2026, month: 7, day: 15, hour: 14, minute: 0, second: 0 });
  assert.equal(toUtcIso(utc), "2026-07-15T13:00:00Z");
});

test("parseUkLocal: rejects impossible calendar dates and unparseable input", () => {
  assert.equal(parseUkLocal("2026-02-30T10:00"), null); // Feb 30 doesn't exist
  assert.equal(parseUkLocal("2026-13-01T10:00"), null); // month 13
  assert.equal(parseUkLocal("2026-01-01T25:00"), null); // hour 25
  assert.equal(parseUkLocal("not-a-date"), null);
  assert.deepEqual(parseUkLocal("2026-12-01T14:00"), {
    year: 2026,
    month: 12,
    day: 1,
    hour: 14,
    minute: 0,
    second: 0,
  });
});

test("isQuarterAligned: only 00/15/30/45 pass", () => {
  for (const m of [0, 15, 30, 45]) assert.equal(isQuarterAligned(m), true, `${m} should align`);
  for (const m of [1, 7, 14, 16, 29, 31, 44, 46, 59]) assert.equal(isQuarterAligned(m), false, `${m} should not align`);
});

test("validateUkSchedule: BST summer value converts to the correct UTC instant", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const result = validateUkSchedule("2026-07-15T14:00", now);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.utcIso, "2026-07-15T13:00:00Z");
});

test("validateUkSchedule: GMT winter value converts to the correct UTC instant", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const result = validateUkSchedule("2026-01-15T14:00", now);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.utcIso, "2026-01-15T14:00:00Z");
});

test("validateUkSchedule: rejects non-aligned minutes and non-zero seconds", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const misaligned = validateUkSchedule("2026-06-01T13:07", now);
  assert.equal(misaligned.ok, false);
  if (!misaligned.ok) assert.equal(misaligned.code, "not_aligned");

  const withSeconds = validateUkSchedule("2026-06-01T13:00:30", now);
  assert.equal(withSeconds.ok, false);
  if (!withSeconds.ok) assert.equal(withSeconds.code, "seconds_not_zero");
});

test("validateUkSchedule: enforces the 20-minute lead (boundary is inclusive)", () => {
  const now = new Date("2026-01-01T00:10:00Z"); // 00:10 London (GMT)
  const exactly20 = validateUkSchedule("2026-01-01T00:30", now);
  assert.equal(exactly20.ok, true, "20 minutes exactly must pass");

  const now2 = new Date("2026-01-01T00:00:00Z");
  const only15 = validateUkSchedule("2026-01-01T00:15", now2);
  assert.equal(only15.ok, false);
  if (!only15.ok) assert.equal(only15.code, "too_soon");
});

test("validateUkSchedule: rejects absurd future dates", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const result = validateUkSchedule("2035-01-01T10:00", now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "too_long");
});

test("formatUkDateTime: shows GMT in winter and BST in summer", () => {
  assert.match(formatUkDateTime(new Date("2026-01-15T14:00:00Z")), /GMT/);
  assert.match(formatUkDateTime(new Date("2026-07-15T13:00:00Z")), /BST/);
});

// =======================================================================================
// validate.ts
// =======================================================================================

test("normalizeUkMobile: accepts the common spellings and canonicalizes to +447…", () => {
  const expected = "+447700900077";
  for (const input of ["+447700900077", "447700900077", "07700900077", "+44 7700 900077", "0770-0900-077", "00447700900077"]) {
    assert.equal(normalizeUkMobile(input), expected, `failed on ${input}`);
    assert.equal(isValidUkMobile(input), true);
  }
});

test("normalizeUkMobile: rejects non-UK-mobile inputs", () => {
  for (const input of [
    "+44770090007", // too short
    "+4477009000777", // too long
    "+441234567890", // landline (London)
    "+353871234567", // non-UK
    "0770090007a", // letter
    "", // empty
    "hello", // nonsense
  ]) {
    assert.equal(normalizeUkMobile(input), null, `should reject ${input}`);
    assert.equal(isValidUkMobile(input), false);
  }
});

test("buildFullMessage: appends the opt-out suffix after a single space", () => {
  assert.equal(buildFullMessage("Hi there"), `Hi there ${OPT_OUT_SUFFIX}`);
  assert.equal(OPT_OUT_SUFFIX, "Stop: dhsc.uk/x");
});

test("messageBudget: the suffix is charged first, leaving 144 body chars (GSM-7)", () => {
  const budget = messageBudget();
  assert.equal(budget.suffixLength, OPT_OUT_SUFFIX.length);
  assert.equal(budget.encoding, "GSM-7");
  assert.equal(budget.maxBodyLength, 144); // 160 - 15 (suffix) - 1 (separator space)
});

test("validateCampaign: accepts a campaign at the exact single-segment boundary", () => {
  const result = validateCampaign({ name: "Promo", senderId: "DHSC", message: "a".repeat(144), mode: "IMMEDIATE" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.segments.segments, 1);
    assert.equal(result.value.segments.length, 160);
    assert.equal(result.value.scheduleDateUtc, null);
    assert.equal(campaignCredits(result.value, 8060), 8060);
  }
});

test("validateCampaign: rejects one character over the single-segment budget", () => {
  const result = validateCampaign({ name: "Promo", senderId: "DHSC", message: "a".repeat(145), mode: "IMMEDIATE" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.field, "message");
    assert.equal(result.issues[0]?.code, "too_long");
  }
});

test("validateCampaign: an emoji shrinks the budget (whole message becomes UCS-2)", () => {
  // Under UCS-2 a single segment holds 70 units; suffix (15) + space (1) leaves 54.
  // A 60-char body + emoji is well over, so it must be rejected.
  const result = validateCampaign({ name: "Promo", senderId: "DHSC", message: "a".repeat(60) + "😀", mode: "IMMEDIATE" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, "too_long");
});

test("validateCampaign: rejects empty name, bad sender charset, over-long sender and < >", () => {
  const emptyName = validateCampaign({ name: "  ", senderId: "DHSC", message: "hi", mode: "IMMEDIATE" });
  assert.equal(emptyName.ok, false);
  if (!emptyName.ok) assert.equal(emptyName.issues[0]?.field, "name");

  const badSender = validateCampaign({ name: "X", senderId: "BAD!", message: "hi", mode: "IMMEDIATE" });
  assert.equal(badSender.ok, false);
  if (!badSender.ok) assert.equal(badSender.issues[0]?.code, "invalid_charset");

  const longSender = validateCampaign({ name: "X", senderId: "abcdefghijkl", message: "hi", mode: "IMMEDIATE" });
  assert.equal(longSender.ok, false);
  if (!longSender.ok) assert.equal(longSender.issues[0]?.code, "too_long");

  const angle = validateCampaign({ name: "X", senderId: "DHSC", message: "a<b", mode: "IMMEDIATE" });
  assert.equal(angle.ok, false);
  if (!angle.ok) assert.equal(angle.issues[0]?.code, "angle_brackets");
});

test("validateCampaign: a scheduled campaign requires a valid UK time and yields UTC", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  const missing = validateCampaign({ name: "X", senderId: "DHSC", message: "hi", mode: "SCHEDULED" }, { now });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.issues[0]?.field, "scheduleLocal");

  const ok = validateCampaign(
    { name: "X", senderId: "DHSC", message: "hi", mode: "SCHEDULED", scheduleLocal: "2026-07-15T14:00" },
    { now },
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.scheduleDateUtc, "2026-07-15T13:00:00Z");
});

// =======================================================================================
// sendmode.ts — request shape, auth quirk, and result classification (mocked fetch)
// =======================================================================================

/** Capture the single request a mocked fetch received. */
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Build a mock fetch + a config that returns `body` at `status`, capturing the request. */
function mockConfig(
  response: { status: number; body: unknown; raw?: boolean } | { reject: Error },
  captured: Captured,
): SendmodeConfig {
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = (init?.method ?? "GET").toUpperCase();
    captured.headers = (init?.headers ?? {}) as Record<string, string>;
    captured.body = typeof init?.body === "string" ? init.body : undefined;
    if ("reject" in response) throw response.reject;
    const text = response.raw ? String(response.body) : JSON.stringify(response.body);
    return new Response(text, { status: response.status });
  }) as unknown as typeof fetch;
  return { accessKey: "test-key-123", fetch: doFetch };
}

function newCaptured(): Captured {
  return { url: "", method: "", headers: {}, body: undefined };
}

test("getBalance: hits /3.0/balance with a BARE Authorization header (no Bearer)", async () => {
  const captured = newCaptured();
  const config = mockConfig(
    { status: 200, body: { balance: 42, is_successful: true, error_message: null, accept_date: "2025-08-25T08:04:55Z" } },
    captured,
  );
  const result = await getBalance(config);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.balance, 42);

  assert.equal(captured.url, `${SENDMODE_BASE_URL}/3.0/balance`);
  assert.equal(captured.method, "GET");
  assert.equal(captured.headers.Authorization, "test-key-123");
  assert.equal(captured.headers.Authorization?.startsWith("Bearer"), false);
});

test("sendBulk: POST /3.0/send/bulk maps camelCase → snake_case and sets JSON content type", async () => {
  const captured = newCaptured();
  const config = mockConfig(
    { status: 200, body: { invalid_mobile_numbers: [], request_id: "req-1", is_successful: true, error_message: null, accept_date: "t" } },
    captured,
  );
  const result = await sendBulk(config, {
    senderId: "DHSC",
    message: "Hello",
    mobileNumbers: ["+447700900077"],
    customerId: "batch-1",
    tags: ["Promo"],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.request_id, "req-1");

  assert.equal(captured.url, `${SENDMODE_BASE_URL}/3.0/send/bulk`);
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(captured.body ?? "{}"), {
    sender_id: "DHSC",
    message: "Hello",
    mobile_numbers: ["+447700900077"],
    customer_id: "batch-1",
    tags: ["Promo"],
  });
});

test("scheduleBulk: POST /3.0/schedule/bulk includes schedule_date", async () => {
  const captured = newCaptured();
  const config = mockConfig(
    { status: 200, body: { invalid_mobile_numbers: [], request_id: "req-2", is_successful: true, error_message: null, accept_date: "t" } },
    captured,
  );
  const result = await scheduleBulk(config, { senderId: "DHSC", message: "Hello", mobileNumbers: ["+447700900077"] }, "2026-06-01T13:15:00Z");
  assert.equal(result.ok, true);

  assert.equal(captured.url, `${SENDMODE_BASE_URL}/3.0/schedule/bulk`);
  assert.deepEqual(JSON.parse(captured.body ?? "{}"), {
    sender_id: "DHSC",
    message: "Hello",
    mobile_numbers: ["+447700900077"],
    schedule_date: "2026-06-01T13:15:00Z",
  });
});

test("cancelSchedule: DELETE /3.0/schedule carries a JSON body + Content-Type (the quirk)", async () => {
  const captured = newCaptured();
  const config = mockConfig(
    { status: 200, body: { is_successful: true, error_message: null, accept_date: "t" } },
    captured,
  );
  const result = await cancelSchedule(config, "req-9");
  assert.equal(result.ok, true);

  assert.equal(captured.url, `${SENDMODE_BASE_URL}/3.0/schedule`);
  assert.equal(captured.method, "DELETE");
  assert.equal(captured.headers["Content-Type"], "application/json");
  assert.equal(captured.headers.Authorization, "test-key-123");
  assert.deepEqual(JSON.parse(captured.body ?? "{}"), { request_id: "req-9" });
});

test("failure classification: 400/401 non-retryable, 429 rate-limited, 5xx server error", async () => {
  const cases: Array<{ status: number; reason: string }> = [
    { status: 400, reason: "bad_request" },
    { status: 401, reason: "unauthorized" },
    { status: 429, reason: "rate_limited" },
    { status: 500, reason: "server_error" },
    { status: 503, reason: "server_error" },
  ];
  for (const { status, reason } of cases) {
    const captured = newCaptured();
    const config = mockConfig({ status, body: { is_successful: false, error_message: "nope", accept_date: null } }, captured);
    const result = await getBalance(config);
    assert.equal(result.ok, false, `status ${status} should fail`);
    if (!result.ok) {
      assert.equal(result.reason, reason);
      assert.equal(result.status, status);
    }
  }
});

test("failure classification: transport error → network; non-JSON 2xx → invalid_response", async () => {
  const netCaptured = newCaptured();
  const netConfig = mockConfig({ reject: new TypeError("connection reset") }, netCaptured);
  const netResult = await getBalance(netConfig);
  assert.equal(netResult.ok, false);
  if (!netResult.ok) {
    assert.equal(netResult.reason, "network");
    assert.equal(netResult.status, null);
  }

  const badCaptured = newCaptured();
  const badConfig = mockConfig({ status: 200, body: { not: "valid" } }, badCaptured);
  const badResult = await getBalance(badConfig);
  assert.equal(badResult.ok, false);
  if (!badResult.ok) assert.equal(badResult.reason, "invalid_response");

  const htmlCaptured = newCaptured();
  const htmlConfig = mockConfig({ status: 200, body: "<html>gateway</html>", raw: true }, htmlCaptured);
  const htmlResult = await getBalance(htmlConfig);
  assert.equal(htmlResult.ok, false);
  if (!htmlResult.ok) assert.equal(htmlResult.reason, "invalid_response");
});

test("baseUrl override lets tests point at a fake host without touching production", async () => {
  const captured = newCaptured();
  const config = mockConfig(
    { status: 200, body: { balance: 1, is_successful: true, error_message: null, accept_date: "t" } },
    captured,
  );
  await getBalance({ ...config, baseUrl: "https://example.test/" });
  assert.equal(captured.url, "https://example.test/3.0/balance");
});
