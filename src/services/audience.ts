/**
 * Audience computation — the read side of the static, pre-chunked contact list
 * (`audience_chunks`) combined with the `opt_outs` blacklist.
 *
 * The CSV is seeded once and never edited in-app (mission.md §5). What changes is the
 * **opt-out set**, so "how many valid recipients do we have?" is always
 * `sum(recipient_count) - (#opt-outs)` and "who do we send to?" is every chunk **minus**
 * any opted-out numbers. Both are computed here so the balance endpoint, campaign creation,
 * and the test-SMS path agree by construction.
 *
 * D1 limits respected (hard rule #4): each helper issues at most a couple of tiny queries;
 * none bind more than a handful of parameters.
 */

import { allRows, firstRow } from "../db/client.js";

/** Total seeded recipients across every chunk (`sum(recipient_count)`). */
export async function totalAudienceCount(db: D1Database): Promise<number> {
  const row = await firstRow<{ total: number }>(
    db,
    "SELECT COALESCE(SUM(recipient_count), 0) AS total FROM audience_chunks",
  );
  return Number(row?.total ?? 0);
}

/** Number of distinct opted-out numbers currently blacklisted. */
export async function optOutCount(db: D1Database): Promise<number> {
  const row = await firstRow<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM opt_outs",
  );
  return Number(row?.count ?? 0);
}

/**
 * The valid recipient count the dashboard shows: seeded total minus current opt-outs.
 * Clamped at zero so a blacklist larger than the audience (should never happen) cannot
 * report a negative head count.
 */
export async function validRecipientCount(db: D1Database): Promise<number> {
  const [total, optedOut] = await Promise.all([totalAudienceCount(db), optOutCount(db)]);
  return Math.max(0, total - optedOut);
}

/** All opt-out numbers as a `Set` for fast membership testing during a chunk sweep. */
export async function loadOptOutSet(db: D1Database): Promise<Set<string>> {
  const rows = await allRows<{ mobile_number: string }>(
    db,
    "SELECT mobile_number FROM opt_outs",
  );
  return new Set(rows.map((r) => r.mobile_number));
}

/** One audience chunk's numbers, with its provider-matching chunk index. */
export interface AudienceChunk {
  chunkIndex: number;
  recipients: string[];
}

/**
 * Load every chunk's recipient list, in `chunk_index` order, with opted-out numbers removed.
 *
 * Numbers are stripped **here** (not at send time) so the batch count and the per-batch
 * recipient lists are exactly what will be sent — the operator sees an accurate cost and the
 * provider never receives a blacklisted number (mission.md §4.6).
 *
 * Chunks that become empty after stripping are dropped, so we never enqueue a send job with
 * zero recipients.
 */
export async function loadAudienceChunks(
  db: D1Database,
  optOuts: Set<string>,
): Promise<AudienceChunk[]> {
  const rows = await allRows<{ chunk_index: number; mobile_numbers_json: string }>(
    db,
    "SELECT chunk_index, mobile_numbers_json FROM audience_chunks ORDER BY chunk_index ASC",
  );

  const chunks: AudienceChunk[] = [];
  for (const row of rows) {
    const recipients = parseRecipients(row.mobile_numbers_json).filter(
      (n) => !optOuts.has(n),
    );
    if (recipients.length > 0) {
      chunks.push({ chunkIndex: row.chunk_index, recipients });
    }
  }
  return chunks;
}

/**
 * Parse a chunk's `mobile_numbers_json` into a string array, ignoring anything that is not a
 * string. The seeder writes a clean array; this is defensive so a hand-edited row cannot
 * crash a request.
 */
function parseRecipients(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}
