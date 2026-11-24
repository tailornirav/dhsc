/**
 * SMS character/segment math — pure functions, no I/O.
 *
 * Product rules (mission.md §8.4, tech.md §7, prototype.md §8):
 *   - GSM-7 is the default alphabet. Non-GSM characters (e.g. emoji, curly quotes, `€` is
 *     actually GSM-7 via extension, but `…`/`–` are not) flip the whole message to UCS-2.
 *   - The opt-out suffix is appended **first** and counts against the budget; the operator's
 *     remaining budget is `hardMax - suffixSegmentsCost`.
 *   - Segment thresholds: GSM-7 single 160 / concatenated 153; UCS-2 single 70 /
 *     concatenated 67.
 *   - Cost = `segments * recipients` credits.
 *
 * We implement the classic 3GPP TS 23.038 GSM 7-bit default alphabet (with the extension
 * table) exactly, so detection matches what real SMSCs/handset do. Characters in the
 * extension table take **two** septets (they are sent as ESC + char).
 */

/**
 * The GSM 7-bit default alphabet, basic set (3GPP TS 23.038). Characters outside this set
 * are non-GSM and force UCS-2.
 */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/**
 * GSM 7-bit extension table (3GPP TS 23.038). Each maps to ESC + one basic char and so
 * consumes **two** septets when counting characters/segments.
 */
const GSM7_EXTENSION = "^{}\\[~]|€";

const GSM7_BASIC_SET: ReadonlySet<string> = new Set(GSM7_BASIC.split(""));
const GSM7_EXTENSION_SET: ReadonlySet<string> = new Set(GSM7_EXTENSION.split(""));

/** Message encoding as the UI labels it. */
export type SmsEncoding = "GSM-7" | "UCS-2";

/** Per-encoding segment thresholds, keyed by single vs concatenated messages. */
const THRESHOLDS: Record<SmsEncoding, { single: number; multipart: number }> = {
  "GSM-7": { single: 160, multipart: 153 },
  "UCS-2": { single: 70, multipart: 67 },
};

/** Result of analysing one message body (encoding, length, segments). */
export interface SegmentInfo {
  encoding: SmsEncoding;
  /**
   * Billable "characters" under the detected encoding: GSM-7 septets (extension chars
   * count as 2) or UTF-16 code units (UCS-2). This is the value compared against the
   * per-encoding thresholds.
   */
  length: number;
  /** Number of SMS segments the message will consume (≥1 for any non-empty message). */
  segments: number;
  /** True when the body is non-empty (an empty body still reports `segments: 0`). */
  isEmpty: boolean;
}

/**
 * Detect the encoding for a string: UCS-2 if it contains any character outside GSM-7
 * (basic or extension), otherwise GSM-7.
 */
export function detectEncoding(text: string): SmsEncoding {
  for (const char of text) {
    if (!GSM7_BASIC_SET.has(char) && !GSM7_EXTENSION_SET.has(char)) return "UCS-2";
  }
  return "GSM-7";
}

/** Count GSM-7 septets (extension-table chars count as 2). */
function gsm7Length(text: string): number {
  let count = 0;
  for (const char of text) {
    count += GSM7_EXTENSION_SET.has(char) ? 2 : 1;
  }
  return count;
}

/** Count UCS-2 code units (what a handset bills against the 70/67 thresholds). */
function ucs2Length(text: string): number {
  return text.length; // JS strings are UTF-16; surrogate pairs already count as 2.
}

/**
 * Analyse a message body: returns encoding, billable length, and segment count.
 *
 * Empty string → `{ encoding: detectEncoding(''), length: 0, segments: 0, isEmpty: true }`.
 * Any non-empty body costs at least one segment (even a single character).
 */
export function analyzeSegments(text: string): SegmentInfo {
  const encoding = detectEncoding(text);
  const length = encoding === "GSM-7" ? gsm7Length(text) : ucs2Length(text);
  const { single, multipart } = THRESHOLDS[encoding];
  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multipart);
  return { encoding, length, segments, isEmpty: length === 0 };
}

/**
 * The largest billable length that still fits in a single segment for the given encoding.
 * Handy for the UI's "Max N chars" helper text.
 */
export function singleSegmentLimit(encoding: SmsEncoding): number {
  return THRESHOLDS[encoding].single;
}

/**
 * Estimated credits for a campaign: `segments * recipients`. Mirrors the live estimator
 * and the pre-flight balance check (tech.md Flow A step 2). Non-positive inputs yield 0.
 */
export function estimatedCredits(segments: number, recipients: number): number {
  if (!Number.isFinite(segments) || !Number.isFinite(recipients)) return 0;
  const s = Math.max(0, Math.floor(segments));
  const r = Math.max(0, Math.floor(recipients));
  return s * r;
}
