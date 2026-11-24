/**
 * Opt-out service — the blacklist that is *always* stripped from every audience
 * (tech.md §4 "Opt-outs", mission.md §4.8).
 *
 * Two writers exist:
 *   - the **public** opt-out page (unauthenticated, rate-limited), which only *adds*; and
 *   - the authenticated Opt-Outs modal, which lists/adds/removes.
 *
 * Both funnel through here so the number is normalised identically and duplicates are
 * impossible (the `mobile_number` primary key makes adds idempotent).
 *
 * Numbers are stored in canonical E.164 (`+447…`); input is normalised first so `07700…` and
 * `+44 7700…` collapse to the same row.
 */

import { allRows, runStatement } from "../db/client.js";
import { normalizeUkMobile } from "../lib/validate.js";

/** A blacklisted number with when it was added. */
export interface OptOutRow {
  mobile_number: string;
  created_at: string;
}

/** List every opt-out, newest first (the modal's order). */
export async function listOptOuts(db: D1Database): Promise<OptOutRow[]> {
  return allRows<OptOutRow>(
    db,
    "SELECT mobile_number, created_at FROM opt_outs ORDER BY created_at DESC",
  );
}

/** Outcome of an add: `added: false` means the number was already blacklisted. */
export interface AddOptOutResult {
  number: string;
  added: boolean;
}

/**
 * Add a number to the blacklist. The input is normalised; an invalid UK mobile returns
 * `null` so the caller can reject with `400`. Re-adding an existing number is a no-op that
 * reports `added: false` (idempotent, so the public form can be submitted twice safely).
 */
export async function addOptOut(
  db: D1Database,
  rawNumber: string,
  now: string,
): Promise<AddOptOutResult | null> {
  const number = normalizeUkMobile(rawNumber);
  if (number === null) return null;

  const result = await runStatement(
    db,
    "INSERT OR IGNORE INTO opt_outs (mobile_number, created_at) VALUES (?, ?)",
    number,
    now,
  );
  return { number, added: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Remove a number from the blacklist. Normalises first. Returns `true` when a row was
 * actually deleted, `false` when it was not present (or invalid input normalises to `null`,
 * in which case nothing can match).
 */
export async function removeOptOut(db: D1Database, rawNumber: string): Promise<boolean> {
  const number = normalizeUkMobile(rawNumber);
  if (number === null) return false;

  const result = await runStatement(
    db,
    "DELETE FROM opt_outs WHERE mobile_number = ?",
    number,
  );
  return (result.meta?.changes ?? 0) > 0;
}
