/**
 * UK time ↔ UTC conversion — pure functions, no I/O, no `moment`/`luxon` (hard rule #5).
 *
 * The operator picks a wall-clock time in **Europe/London** (GMT in winter, BST in
 * summer). The provider needs an **ISO 8601 UTC** string ending in `Z`, aligned to a
 * 15-minute slot (`:00` seconds) and at least 20 minutes in the future (a 5-minute buffer
 * over the provider's own 15-minute minimum, so the last queued batch never arrives late).
 *
 * DST is handled with `Intl.DateTimeFormat({ timeZone: "Europe/London" })`, which knows the
 * historical IANA rules (including GMT/BST). We never hardcode an offset — the offset is
 * derived per instant via a guess-and-correct step.
 */

/** The timezone label the picker shows; storage/transport is always UTC. */
export const UK_TIME_ZONE = "Europe/London";

/** Provider requires 15-minute slots. */
export const SLOT_MINUTES = 15;

/**
 * Minimum lead time in minutes. Product rule is ≥20 (5-minute buffer over the provider's
 * 15-minute minimum), applied to **UTC** (see `mission.md` §8.4 / tech.md Flow A).
 */
export const MIN_LEAD_MINUTES = 20;

/** The `datetime-local` value shape we accept: `YYYY-MM-DDTHH:mm` (optional `:ss`). */
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A parsed wall-clock datetime in UK local time (no offset applied yet). */
export interface UkLocalDateTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/** Why a schedule input was rejected (stable codes the UI/API can map to messages). */
export type ScheduleErrorCode =
  | "unparseable"
  | "invalid_date"
  | "not_aligned"
  | "seconds_not_zero"
  | "too_soon"
  | "too_long";

/** Outcome of validating a UK-local schedule string. */
export type ScheduleValidation =
  | { ok: true; local: UkLocalDateTime; utcIso: string; utcDate: Date }
  | { ok: false; code: ScheduleErrorCode; message: string };

/**
 * The offset of Europe/London from UTC, in minutes, at a given **UTC instant** (positive
 * means local = UTC + offset, i.e. BST = +60, GMT = 0). Derived from `Intl` so it follows
 * the real DST rules; never hardcoded.
 */
function londonOffsetMinutes(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const pick = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return a \`${type}\` part`);
    return Number(part.value);
  };
  const asUTC = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return (asUTC - utcMs) / 60_000;
}

/**
 * Parse a `YYYY-MM-DDTHH:mm[:ss]` string into a `UkLocalDateTime`, rejecting values that
 * do not round-trip (e.g. `2026-02-30`, month `13`). Returns `null` on failure.
 */
export function parseUkLocal(input: string): UkLocalDateTime | null {
  const match = LOCAL_DATETIME.exec(input.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const local: UkLocalDateTime = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s === undefined ? 0 : Number(s),
  };
  // Round-trip through Date.UTC to catch impossible dates (e.g. Feb 30, hour 25).
  const probe = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
  if (
    probe.getUTCFullYear() !== local.year ||
    probe.getUTCMonth() !== local.month - 1 ||
    probe.getUTCDate() !== local.day ||
    probe.getUTCHours() !== local.hour ||
    probe.getUTCMinutes() !== local.minute ||
    probe.getUTCSeconds() !== local.second
  ) {
    return null;
  }
  return local;
}

/**
 * Convert a UK wall-clock datetime to a UTC `Date`. Uses a guess-and-correct step so the
 * result is exact even across a DST transition:
 *   1. Treat the wall clock as if it were UTC and find London's offset at that guess.
 *   2. Subtract the offset; re-check the offset at the candidate instant and correct once
 *      if it changed (the guess landed on the other side of a transition).
 *
 * For the ~1-hour spring-forward gap and the 1-hour autumn overlap the provider/datetime
 * semantics are inherently ambiguous; we resolve deterministically (the guess-and-correct
 * picks the pre-transition offset for the gap). Operators rarely schedule exactly on a
 * transition instant, and slots are 15-minute aligned.
 */
export function ukLocalToUtc(local: UkLocalDateTime): Date {
  const wallAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const guessOffset = londonOffsetMinutes(wallAsUtc);
  let utcMs = wallAsUtc - guessOffset * 60_000;
  const actualOffset = londonOffsetMinutes(utcMs);
  if (actualOffset !== guessOffset) {
    utcMs = wallAsUtc - actualOffset * 60_000;
  }
  return new Date(utcMs);
}

/** Format a `Date` as an ISO 8601 UTC string with milliseconds dropped: `2026-06-01T13:15:00Z`. */
export function toUtcIso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** True when `minute` is one of `00/15/30/45`. */
export function isQuarterAligned(minute: number): boolean {
  return minute % SLOT_MINUTES === 0;
}

/**
 * Validate and convert an operator-supplied UK-local schedule string into an ISO 8601 UTC
 * string, applying every product rule in one place:
 *   - parseable `YYYY-MM-DDTHH:mm[:ss]` and a real calendar date;
 *   - minutes in {00,15,30,45} and seconds `:00`;
 *   - at least `MIN_LEAD_MINUTES` in the future (compared in UTC);
 *   - not absurdly far ahead (guards typos like a wrong year).
 *
 * `now` is injectable for deterministic tests; it defaults to the current time.
 */
export function validateUkSchedule(
  input: string,
  now: Date = new Date(),
  options: { minLeadMinutes?: number } = {},
): ScheduleValidation {
  const minLead = options.minLeadMinutes ?? MIN_LEAD_MINUTES;

  const local = parseUkLocal(input);
  if (!local) {
    // Distinguish "not a datetime at all" from "an impossible date" for a clearer message.
    const shapeOk = LOCAL_DATETIME.test(input.trim());
    return shapeOk
      ? { ok: false, code: "invalid_date", message: "That is not a valid calendar date and time." }
      : { ok: false, code: "unparseable", message: "Enter the date and time as YYYY-MM-DDTHH:mm." };
  }

  if (local.second !== 0) {
    return { ok: false, code: "seconds_not_zero", message: "Seconds must be :00." };
  }
  if (!isQuarterAligned(local.minute)) {
    return { ok: false, code: "not_aligned", message: `Minutes must be one of 00, 15, 30, 45.` };
  }

  const utcDate = ukLocalToUtc(local);
  const leadMinutes = (utcDate.getTime() - now.getTime()) / 60_000;
  if (leadMinutes < minLead) {
    return {
      ok: false,
      code: "too_soon",
      message: `Pick a time at least ${minLead} minutes from now.`,
    };
  }

  // Guard against a typo'd year (more than ~2 years ahead is almost certainly a mistake).
  const twoYears = 2 * 365 * 24 * 60;
  if (leadMinutes > twoYears) {
    return { ok: false, code: "too_long", message: "That date is more than two years away." };
  }

  return { ok: true, local, utcIso: toUtcIso(utcDate), utcDate };
}

/**
 * Human-readable label for a UTC instant in UK local time (for display). Format is
 * `DD/MM/YYYY, HH:mm` with an explicit `GMT`/`BST` suffix so operators are never in doubt.
 */
export function formatUkDateTime(date: Date): string {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return dtf.format(date);
}

/**
 * Re-exported convenience: the current instant as ISO 8601 UTC (`Z`), seconds precision.
 * Kept here so timing helpers live in one module.
 */
export function nowUtcIso(now: Date = new Date()): string {
  return toUtcIso(now);
}
