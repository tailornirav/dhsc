/**
 * UK date/time helpers for the dashboard — a browser-side mirror of the Worker's
 * `src/lib/uk-time.ts` for anything the UI needs to *show* or *pre-validate*.
 *
 * The operator thinks in **Europe/London** (GMT/BST); storage and the API are **UTC**
 * (tech.md §8, prototype.md §8). The server is authoritative for the actual schedule conversion
 * (it rejects wrong slots, `:00` seconds, and <20-minute leads), but the picker needs:
 *   - a labelled local time,
 *   - a countdown to a scheduled instant,
 *   - a formatted display string with an explicit GMT/BST marker.
 *
 * DST is derived from `Intl` (never hardcoded), exactly like the backend.
 */

export const UK_TIME_ZONE = "Europe/London";

/** Provider/product lead time: ≥20 minutes ahead (uk-time.ts `MIN_LEAD_MINUTES`). */
export const MIN_LEAD_MINUTES = 20;

/** Provider requires 15-minute slots. */
export const SLOT_MINUTES = 15;

/** Minutes allowed in a schedule slot. */
export const SLOT_MINUTES_ALLOWED: readonly number[] = [0, 15, 30, 45];

/**
 * The offset of Europe/London from UTC, in minutes, at a given UTC instant (positive = BST).
 * Derived via `Intl` so DST transitions are honoured without a hardcoded table.
 */
function londonOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    pick("hour"),
    pick("minute"),
    pick("second"),
  );
  return (asUtc - utcMs) / 60_000;
}

/**
 * Convert a UK wall-clock time to a UTC `Date`, using the same guess-and-correct step as the
 * backend so a slot near a DST boundary resolves identically on both sides.
 */
function ukLocalToUtc(local: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): Date {
  const wallAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const guessOffset = londonOffsetMinutes(wallAsUtc);
  let utcMs = wallAsUtc - guessOffset * 60_000;
  const actualOffset = londonOffsetMinutes(utcMs);
  if (actualOffset !== guessOffset) utcMs = wallAsUtc - actualOffset * 60_000;
  return new Date(utcMs);
}

/** Parse a `datetime-local` value (`YYYY-MM-DDTHH:mm[:ss]`) into its wall-clock parts. */
function parseLocalValue(
  value: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const local = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s === undefined ? 0 : Number(s),
  };
  // Reject impossible dates (e.g. Feb 30) by round-tripping through UTC.
  const probe = new Date(
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second),
  );
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

/** The UTC instant (`Date`) for a `datetime-local` value interpreted as UK wall-clock time. */
export function localValueToUtcDate(value: string): Date | null {
  const local = parseLocalValue(value);
  return local === null ? null : ukLocalToUtc(local);
}

/** ISO 8601 UTC (`Z`) for a UK-local `datetime-local` value, or `null` if unparseable. */
export function localValueToUtcIso(value: string): string | null {
  const date = localValueToUtcDate(value);
  return date === null ? null : `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Client-side pre-check of a `datetime-local` value against the schedule rules the server will
 * enforce. Returns `null` when acceptable, otherwise a human-readable reason for the inline hint.
 * The server still validates authoritatively; this only spares the operator a failed round trip.
 */
export function describeScheduleProblem(value: string, now: Date = new Date()): string | null {
  const local = parseLocalValue(value);
  if (!local) return "Enter the date and time as YYYY-MM-DDTHH:mm.";

  if (local.second !== 0) return "Seconds must be :00.";
  if (!SLOT_MINUTES_ALLOWED.includes(local.minute)) return "Minutes must be 00, 15, 30, or 45.";

  const utc = ukLocalToUtc(local);
  const leadMinutes = (utc.getTime() - now.getTime()) / 60_000;
  if (leadMinutes < MIN_LEAD_MINUTES) return `Pick a time at least ${MIN_LEAD_MINUTES} minutes from now.`;

  const twoYears = 2 * 365 * 24 * 60;
  if (leadMinutes > twoYears) return "That date is more than two years away.";

  return null;
}

/**
 * Round a `Date` up to the next 15-minute slot with `:00` seconds, at least `MIN_LEAD_MINUTES`
 * ahead, and return it as a `datetime-local` string in **UK local time** (for prefilling the
 * picker). This is a convenience default; the operator can change it.
 */
export function nextSlotLocalValue(now: Date = new Date()): string {
  const earliestMs = now.getTime() + MIN_LEAD_MINUTES * 60_000;
  const rounded = new Date(Math.ceil(earliestMs / (SLOT_MINUTES * 60_000)) * SLOT_MINUTES * 60_000);
  rounded.setUTCSeconds(0, 0);
  // Convert the UTC instant to UK wall-clock parts so the input shows local time.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(rounded);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  // Intl may render midnight as "24"; normalise to "00".
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  return `${pick("year")}-${pick("month")}-${pick("day")}T${hour}:${pick("minute")}`;
}

/**
 * Human-readable UK display of a UTC ISO instant, e.g. `01/06/2026, 14:15 BST`. Accepts the
 * API's `Z` strings; returns an em dash for null/invalid input so a card never shows "Invalid Date".
 */
export function formatUkDateTime(utcIso: string | null | undefined): string {
  if (!utcIso) return "—";
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

/**
 * Relative dispatch countdown for a queued campaign, e.g. `Dispatches in 45 mins` / `in 2 hrs
 * 10 mins` / `within a minute`. Returns `null` for a null/past instant so callers can omit it.
 */
export function describeCountdown(utcIso: string | null | undefined, now: Date = new Date()): string | null {
  if (!utcIso) return null;
  const target = new Date(utcIso).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - now.getTime();
  if (diffMs <= 0) return null;

  const totalMinutes = Math.round(diffMs / 60_000);
  if (totalMinutes < 1) return "Dispatches within a minute";

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hr" : "hrs"}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} ${minutes === 1 ? "min" : "mins"}`);

  return `Dispatches in ${parts.join(" ")}`;
}
