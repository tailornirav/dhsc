/**
 * Input validation — pure functions, no I/O. Server-side validation is **authoritative**
 * (tech.md §9.4); the UI only mirrors these rules for convenience.
 *
 * Two families live here:
 *   1. UK mobile number validation/normalization (used by campaign audiences, the opt-out
 *      flow, and the test-SMS modal).
 *   2. Campaign input validation (`name`, `sender_id`, `message`, schedule) which composes
 *      the segment math (`sms-segments.ts`) and the UK→UTC scheduler (`uk-time.ts`).
 */

import {
  analyzeSegments,
  estimatedCredits,
  type SegmentInfo,
  type SmsEncoding,
} from "../services/sms-segments.js";
import { validateUkSchedule, MIN_LEAD_MINUTES, type ScheduleErrorCode } from "./uk-time.js";

// ---------------------------------------------------------------------------------------
// Product constants (single source of truth; keep in sync with tech.md / mission.md §8)
// ---------------------------------------------------------------------------------------

/**
 * Opt-out suffix appended to **every** outgoing message, counted **first** against the
 * character budget (mission.md §8.4, prototype.md §8). The prototype uses
 * `Stop: dhsc.uk/x`; keep this constant the one place it is defined.
 */
export const OPT_OUT_SUFFIX = "Stop: dhsc.uk/x";

/** Campaign name cap (prototype.md §5.1). */
export const MAX_NAME_LENGTH = 80;

/** UK sender-ID cap: 11 chars (mission.md §7; the provider allows 15). */
export const MAX_SENDER_ID_LENGTH = 11;

/**
 * Sender-ID charset: letters, digits, and spaces only.
 *
 * The provider's own rule is merely `[^<>]*` (docs/sms-api.md §5.2 shows `"SM Testing"`), so a
 * space is valid and common in practice. We keep a deliberately narrow charset — alphanumerics
 * plus spaces — to stay UK-typical, and reject `<`/`>` explicitly.
 */
const SENDER_ID_PATTERN = /^[A-Za-z0-9 ]+$/;

/**
 * Provider's absolute API cap for the message field (`docs/sms-api.md` §3). This is the
 * protocol ceiling only — the product's real ceiling is lower: the outbound body (operator
 * text + separator + opt-out suffix) must stay within a single segment. See
 * `messageBudget()` for the operator's remaining allowance.
 */
export const PROVIDER_MESSAGE_MAX = 1224;

// ---------------------------------------------------------------------------------------
// UK mobile numbers
// ---------------------------------------------------------------------------------------

/** The canonical stored/sent form: `+447` + exactly 9 digits. */
export const UK_MOBILE_E164 = /^\+447\d{9}$/;

/**
 * Normalize a UK mobile number to E.164 (`+447XXXXXXXXX`) or return `null` if it is not a
 * valid UK mobile. Accepts the common operator/CSV spellings:
 *   - `+447700900077`      (already E.164)
 *   - `447700900077`       (no plus)
 *   - `07700900077`        (national, leading trunk `0`)
 *   - `07 700 900 077`     (spaces) / `0770-0900-077` (dashes) / `(0770) 900077`
 *
 * Everything else (landlines starting `+441`/`+442`, wrong length, letters) returns `null`.
 */
export function normalizeUkMobile(input: string): string | null {
  if (typeof input !== "string") return null;

  // Strip all whitespace and common separators.
  const cleaned = input.replace(/[\s()\-.]/g, "");

  let national: string;
  if (cleaned.startsWith("+44")) {
    national = "0" + cleaned.slice(3);
  } else if (cleaned.startsWith("0044")) {
    national = "0" + cleaned.slice(4);
  } else if (cleaned.startsWith("44")) {
    national = "0" + cleaned.slice(2);
  } else if (cleaned.startsWith("0")) {
    national = cleaned;
  } else {
    national = "0" + cleaned;
  }

  // A UK mobile is `07` + 9 digits (11 digits total).
  if (!/^07\d{9}$/.test(national)) return null;
  return "+44" + national.slice(1);
}

/** True if `input` normalizes to a valid UK mobile. */
export function isValidUkMobile(input: string): boolean {
  return normalizeUkMobile(input) !== null;
}

/** Result of parsing a pasted manual recipient list. */
export interface ManualRecipients {
  /** Valid, deduplicated, E.164-normalised numbers (order-preserving). */
  numbers: string[];
  /** Entries that failed normalization, exactly as the operator typed them. */
  invalid: string[];
}

/**
 * Parse an operator-pasted recipient list into normalised numbers plus the raw bad entries.
 *
 * Splits on newlines, commas, and semicolons (with surrounding whitespace), normalises each
 * entry with `normalizeUkMobile` — the one authoritative UK-mobile rule (mission.md §6.5,
 * tech.md §9.4) — de-duplicates the valid set while preserving first-seen order, and returns
 * the invalid entries **as given** so the API can name the offending value in its error.
 *
 * Pure and I/O-free so the route and the web mirror share one rule (roadmap 12.1.1).
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

// ---------------------------------------------------------------------------------------
// Campaign input
// ---------------------------------------------------------------------------------------

/** Violation shape (stable `code` + human `message` + the offending `field`). */
export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

/** Operator-supplied campaign draft (as it arrives from the client). */
export interface CampaignInput {
  name: string;
  /** Provisioned sender ID; the operator does not invent it, but we validate it anyway. */
  senderId: string;
  /** The operator's message body **without** the suffix (the suffix is appended by us). */
  message: string;
  /** `IMMEDIATE` sends now; `SCHEDULED` requires `scheduleLocal` in UK local time. */
  mode: "IMMEDIATE" | "SCHEDULED";
  /** UK-local wall clock `YYYY-MM-DDTHH:mm`; required when `mode === "SCHEDULED"`. */
  scheduleLocal?: string;
}

/** A fully validated campaign, ready to persist and enqueue. */
export interface ValidatedCampaign {
  name: string;
  senderId: string;
  /** The operator's text (no suffix). */
  message: string;
  /** The exact text we send: `message` + a separating space + the opt-out suffix. */
  fullMessage: string;
  mode: "IMMEDIATE" | "SCHEDULED";
  /** ISO 8601 UTC (`Z`) or `null` for immediate sends. */
  scheduleDateUtc: string | null;
  /** Segment analysis of `fullMessage` (drives credits + the UI estimator). */
  segments: SegmentInfo;
}

/** Reject any `<`/`>` — the provider's `[^<>]*` rule for `sender_id` and `message`. */
function containsAngleBrackets(text: string): boolean {
  return text.includes("<") || text.includes(">");
}

/**
 * The operator's per-message character allowance, given the appended suffix. Under GSM-7
 * the suffix itself may contain only basic chars (it does), so the budget is
 * `160 - suffixSeptets`. Under UCS-2 the whole message (suffix + body) shares the UCS-2
 * thresholds, so we report how many body characters still fit in a **single** segment.
 *
 * Returned as a small object so the UI can label "Max N chars" and show the suffix cost.
 */
export function messageBudget(suffix: string = OPT_OUT_SUFFIX): {
  suffixLength: number;
  suffixSegments: number;
  /** Max billable body length that keeps `suffix + body` within a single segment. */
  maxBodyLength: number;
  encoding: SmsEncoding;
  singleSegmentLimit: number;
} {
  const suffixInfo = analyzeSegments(suffix);
  // Under GSM-7 a single segment holds 160 septets; under UCS-2 it holds 70 code units.
  const singleSegmentLimit = suffixInfo.encoding === "GSM-7" ? 160 : 70;
  // The separator space between body and suffix is part of the payload too.
  const suffixCost = suffixInfo.length + 1;
  return {
    suffixLength: suffixInfo.length,
    suffixSegments: suffixInfo.segments,
    maxBodyLength: Math.max(0, singleSegmentLimit - suffixCost),
    encoding: suffixInfo.encoding,
    singleSegmentLimit,
  };
}

/**
 * Assemble the exact outbound body: the operator's trimmed message followed by the opt-out
 * suffix, separated by a single space. Kept in one function so the estimator, validation,
 * and the actual send can never disagree.
 */
export function buildFullMessage(message: string, suffix: string = OPT_OUT_SUFFIX): string {
  return `${message} ${suffix}`;
}

/**
 * Validate a campaign draft end-to-end. Returns either the issues (field-by-field) or the
 * fully-validated campaign with segment analysis and the UTC schedule.
 *
 * Rules enforced (tech.md Flow A step 1, mission.md §8.4):
 *   - `name`: 1–80 chars after trim.
 *   - `senderId`: 1–11 chars, letters/digits/spaces (UK practice), no `<>`.
 *   - `message`: 1–1224 chars, no `<>`. **Hard max: the whole outbound body (body + suffix)
 *     must fit 160 chars in GSM-7**, or the UCS-2 equivalent. We reject when the outbound
 *     body needs more than one segment.
 *   - `mode`: `IMMEDIATE` or `SCHEDULED`; scheduled requires a valid UK-local time meeting
 *     all slot/lead rules.
 *
 * Why reject multi-segment here? The product rule is **160 characters is a hard maximum**
 * (single segment). We compute the outbound `fullMessage` and require its segment count to
 * be exactly 1; anything longer is a hard error so cost can never silently double.
 */
export function validateCampaign(
  input: CampaignInput,
  options: { now?: Date; suffix?: string } = {},
): { ok: true; value: ValidatedCampaign } | { ok: false; issues: ValidationIssue[] } {
  const now = options.now ?? new Date();
  const suffix = options.suffix ?? OPT_OUT_SUFFIX;
  const issues: ValidationIssue[] = [];

  // ---- name ----
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) {
    issues.push({ field: "name", code: "required", message: "Campaign name is required." });
  } else if (name.length > MAX_NAME_LENGTH) {
    issues.push({
      field: "name",
      code: "too_long",
      message: `Campaign name must be ${MAX_NAME_LENGTH} characters or fewer.`,
    });
  }

  // ---- senderId ----
  const senderId = typeof input.senderId === "string" ? input.senderId.trim() : "";
  if (senderId.length === 0) {
    issues.push({ field: "senderId", code: "required", message: "Sender ID is required." });
  } else if (senderId.length > MAX_SENDER_ID_LENGTH) {
    issues.push({
      field: "senderId",
      code: "too_long",
      message: `Sender ID must be ${MAX_SENDER_ID_LENGTH} characters or fewer.`,
    });
  } else if (containsAngleBrackets(senderId)) {
    issues.push({ field: "senderId", code: "angle_brackets", message: "Sender ID cannot contain < or >." });
  } else if (!SENDER_ID_PATTERN.test(senderId)) {
    issues.push({
      field: "senderId",
      code: "invalid_charset",
      message: "Sender ID may only contain letters, numbers and spaces.",
    });
  }

  // ---- message ----
  const rawMessage = typeof input.message === "string" ? input.message : "";
  const message = rawMessage.trim();
  if (message.length === 0) {
    issues.push({ field: "message", code: "required", message: "Message body is required." });
  } else if (containsAngleBrackets(message)) {
    issues.push({ field: "message", code: "angle_brackets", message: "Message cannot contain < or >." });
  }

  const fullMessage = buildFullMessage(message, suffix);
  const segments = analyzeSegments(fullMessage);

  if (message.length > 0) {
    if (fullMessage.length > PROVIDER_MESSAGE_MAX) {
      issues.push({
        field: "message",
        code: "provider_max",
        message: `Message cannot exceed ${PROVIDER_MESSAGE_MAX} characters.`,
      });
    } else if (segments.segments > 1) {
      // Hard product cap: the outbound body (including suffix) must be a single segment.
      const budget = messageBudget(suffix);
      issues.push({
        field: "message",
        code: "too_long",
        message:
          `Message plus the opt-out suffix must fit one ${segments.encoding} segment ` +
          `(max ${budget.maxBodyLength} characters for your text).`,
      });
    }
  }

  // ---- mode + schedule ----
  let scheduleDateUtc: string | null = null;
  if (input.mode !== "IMMEDIATE" && input.mode !== "SCHEDULED") {
    issues.push({ field: "mode", code: "invalid", message: "Delivery mode must be IMMEDIATE or SCHEDULED." });
  } else if (input.mode === "SCHEDULED") {
    if (typeof input.scheduleLocal !== "string" || input.scheduleLocal.trim() === "") {
      issues.push({ field: "scheduleLocal", code: "required", message: "Pick a date and time to schedule." });
    } else {
      const schedule = validateUkSchedule(input.scheduleLocal, now);
      if (!schedule.ok) {
        issues.push({
          field: "scheduleLocal",
          code: schedule.code satisfies ScheduleErrorCode,
          message: schedule.message,
        });
      } else {
        scheduleDateUtc = schedule.utcIso;
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      name,
      senderId,
      message,
      fullMessage,
      mode: input.mode as "IMMEDIATE" | "SCHEDULED",
      scheduleDateUtc,
      segments,
    },
  };
}

/**
 * Convenience: pre-flight credit estimate for a validated campaign against a recipient
 * count. `segments * recipients` (tech.md Flow A step 2).
 */
export function campaignCredits(campaign: ValidatedCampaign, recipients: number): number {
  return estimatedCredits(campaign.segments.segments, recipients);
}

/** Re-export so callers can surface the lead-time rule without importing uk-time directly. */
export { MIN_LEAD_MINUTES };
