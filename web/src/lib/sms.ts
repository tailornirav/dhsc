/**
 * Client-side SMS encoding/segment math — a faithful mirror of the Worker's
 * `src/services/sms-segments.ts` and the message-budget rule in `src/lib/validate.ts`.
 *
 * Why duplicate it? The prototype (prototype.md §8) requires the estimator to update on **every
 * keystroke**: encoding (GSM-7 ⇄ UCS-2), characters, segments, recipients, and cost. Round-
 * tripping each keystroke to the server would be wasteful and laggy, so the UI computes locally
 * for instant feedback. Server-side validation stays **authoritative** (tech.md §9.4) — this file
 * exists only to keep the numbers the operator sees identical to the numbers the server will use.
 *
 * Keep the tables and thresholds byte-for-byte in sync with the backend; if that file changes,
 * change this one in the same commit.
 */

/** The opt-out suffix appended to every outbound message, counted first (mission.md §8.4). */
export const OPT_OUT_SUFFIX = "Stop: dhsc.uk/x";

/** Campaign name cap (prototype.md §5.1). */
export const MAX_NAME_LENGTH = 80;

/** UK sender-ID cap: 11 chars; letters, digits and spaces (mission.md §7). */
export const MAX_SENDER_ID_LENGTH = 11;

/** GSM 7-bit default alphabet, basic set (3GPP TS 23.038). */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** GSM 7-bit extension table — each char costs two septets (ESC + char). */
const GSM7_EXTENSION = "^{}\\[~]|€";

const GSM7_BASIC_SET: ReadonlySet<string> = new Set(GSM7_BASIC.split(""));
const GSM7_EXTENSION_SET: ReadonlySet<string> = new Set(GSM7_EXTENSION.split(""));

/** Message encoding as the UI labels it. */
export type SmsEncoding = "GSM-7" | "UCS-2";

/** Per-encoding single/multipart segment thresholds. */
const THRESHOLDS: Record<SmsEncoding, { single: number; multipart: number }> = {
  "GSM-7": { single: 160, multipart: 153 },
  "UCS-2": { single: 70, multipart: 67 },
};

/** Result of analysing one message body. */
export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Billable length under the detected encoding (GSM-7 septets / UCS-2 code units). */
  length: number;
  /** Number of SMS segments (0 for an empty body). */
  segments: number;
  isEmpty: boolean;
}

/** UCS-2 if any character is outside GSM-7 (basic or extension); GSM-7 otherwise. */
export function detectEncoding(text: string): SmsEncoding {
  for (const char of text) {
    if (!GSM7_BASIC_SET.has(char) && !GSM7_EXTENSION_SET.has(char)) return "UCS-2";
  }
  return "GSM-7";
}

function gsm7Length(text: string): number {
  let count = 0;
  for (const char of text) count += GSM7_EXTENSION_SET.has(char) ? 2 : 1;
  return count;
}

/** Analyse a message body: encoding, billable length, and segment count. */
export function analyzeSegments(text: string): SegmentInfo {
  const encoding = detectEncoding(text);
  const length = encoding === "GSM-7" ? gsm7Length(text) : text.length;
  const { single, multipart } = THRESHOLDS[encoding];
  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multipart);
  return { encoding, length, segments, isEmpty: length === 0 };
}

/** Assemble the exact outbound body: operator text + separating space + suffix. */
export function buildFullMessage(message: string, suffix: string = OPT_OUT_SUFFIX): string {
  return `${message} ${suffix}`;
}

/** The operator's single-segment character allowance, given the appended suffix. */
export interface MessageBudget {
  suffixLength: number;
  /** Segment count of the suffix itself (drives the "−N for …" helper text). */
  suffixSegments: number;
  /** Max billable body length that keeps `body + suffix` within one segment. */
  maxBodyLength: number;
  encoding: SmsEncoding;
  singleSegmentLimit: number;
}

/**
 * Mirror of the backend `messageBudget()`: under GSM-7 a single segment holds 160 septets; under
 * UCS-2 it holds 70 code units. The separator space counts against the budget too.
 */
export function messageBudget(suffix: string = OPT_OUT_SUFFIX): MessageBudget {
  const suffixInfo = analyzeSegments(suffix);
  const singleSegmentLimit = suffixInfo.encoding === "GSM-7" ? 160 : 70;
  const suffixCost = suffixInfo.length + 1;
  return {
    suffixLength: suffixInfo.length,
    suffixSegments: suffixInfo.segments,
    maxBodyLength: Math.max(0, singleSegmentLimit - suffixCost),
    encoding: suffixInfo.encoding,
    singleSegmentLimit,
  };
}

/** Estimated credits for a campaign: `segments * recipients`. */
export function estimatedCredits(segments: number, recipients: number): number {
  if (!Number.isFinite(segments) || !Number.isFinite(recipients)) return 0;
  const s = Math.max(0, Math.floor(segments));
  const r = Math.max(0, Math.floor(recipients));
  return s * r;
}

// ---------------------------------------------------------------------------------------
// UK mobile validation (mirror of `normalizeUkMobile` in the Worker's validate.ts)
// ---------------------------------------------------------------------------------------

/**
 * Normalize a UK mobile to E.164 (`+447XXXXXXXXX`) or return `null`. Accepts the same spellings
 * as the server (`+4477…`, `4477…`, `077…`, with spaces/dashes/parens). Used by the Test-SMS and
 * Opt-Out inputs so the UI rejects a bad number before spending a round trip (prototype.md §8).
 */
export function normalizeUkMobile(input: string): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[\s()\-.]/g, "");

  let national: string;
  if (cleaned.startsWith("+44")) national = "0" + cleaned.slice(3);
  else if (cleaned.startsWith("0044")) national = "0" + cleaned.slice(4);
  else if (cleaned.startsWith("44")) national = "0" + cleaned.slice(2);
  else if (cleaned.startsWith("0")) national = cleaned;
  else national = "0" + cleaned;

  if (!/^07\d{9}$/.test(national)) return null;
  return "+44" + national.slice(1);
}

/** Result of parsing a pasted manual recipient list (mirror of the server type). */
export interface ManualRecipients {
  /** Valid, deduplicated, E.164-normalised numbers (order-preserving). */
  numbers: string[];
  /** Entries that failed normalization, exactly as the operator typed them. */
  invalid: string[];
}

/**
 * Parse an operator-pasted recipient list into normalised numbers plus the raw bad entries.
 *
 * A **byte-for-byte behavioural mirror** of `parseManualRecipients` in the Worker's
 * `src/lib/validate.ts` (tech.md §10): splits on newlines, commas, and semicolons (with
 * surrounding whitespace), normalises each entry with the local `normalizeUkMobile`, de-duplicates
 * the valid set while preserving first-seen order, and returns the invalid entries **as given** so
 * the UI can surface the offending value inline. Client validation is convenience only — the
 * server remains authoritative (tech.md §9.4, roadmap 12.3.1). Keep in sync with the server.
 */
export function parseManualRecipients(raw: string): ManualRecipients {
  const numbers: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(/[\n,;]+/)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const normalized = normalizeUkMobile(trimmed);
    if (normalized === null) {
      invalid.push(trimmed);
    } else if (!seen.has(normalized)) {
      seen.add(normalized);
      numbers.push(normalized);
    }
  }

  return { numbers, invalid };
}

/** Counts for the audience sanitization strip when "Specific Numbers" is selected. */
export interface ManualRecipientSummary {
  /** Non-empty, trimmed entries the operator typed. */
  entered: number;
  /** Valid entries dropped because the same normalised number already appeared. */
  duplicates: number;
  /** Valid, de-duplicated numbers found on the opt-out blacklist. */
  optedOut: number;
  /** Final billable numbers (valid − opted-out), order-preserving. */
  numbers: string[];
  /** Entries that failed normalization, exactly as the operator typed them. */
  invalid: string[];
}

/**
 * Derive the pasted-list strip counts (`Entered → −Duplicate → −Opted-Out → = Valid`,
 * prototype.md §5.1). Builds on the mirrored `parseManualRecipients` so the "Valid" number is
 * identical to what the server will enqueue. The opt-out set is the client's normalised blacklist
 * (`+447…`); only convenience feedback — the server re-checks opt-outs at dispatch (mission §8.4).
 */
export function summarizeManualRecipients(
  raw: string,
  optOutSet: ReadonlySet<string>,
): ManualRecipientSummary {
  const { numbers, invalid } = parseManualRecipients(raw);

  let entered = 0;
  const validSeen = new Set<string>();
  let duplicates = 0;
  for (const entry of raw.split(/[\n,;]+/)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    entered += 1;
    const normalized = normalizeUkMobile(trimmed);
    if (normalized === null || validSeen.has(normalized)) {
      if (normalized !== null) duplicates += 1;
      continue;
    }
    validSeen.add(normalized);
  }

  const billable = numbers.filter((n) => !optOutSet.has(n));
  const optedOut = numbers.length - billable.length;

  return { entered, duplicates, optedOut, numbers: billable, invalid };
}
