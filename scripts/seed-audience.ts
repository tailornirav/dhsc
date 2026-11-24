/**
 * One-time audience seeder: `docs/data.csv` -> `audience_chunks`.
 *
 * Reads `docs/data.csv` (header `customer_name,phone_e164,visit_count`), keeps only
 * rows whose phone is a clean UK mobile (`+447` + 9 digits, i.e. `^\+447\d{9}$`),
 * chunks the survivors into groups of **100** (matches the provider's 100-cap),
 * and emits an idempotent SQL file for the `audience_chunks` table.
 *
 * Why a SQL file (not a live D1 client)?
 *   - No D1 credentials need to touch this machine.
 *   - The output is exactly what `wrangler d1 execute --file` consumes, locally
 *     and remotely, so local and remote seeding are the same command modulo
 *     `--local`/`--remote`.
 *
 * Idempotency & D1 limits (agent.md hard rules #4):
 *   - Starts with `DELETE FROM audience_chunks;` so re-running fully replaces
 *     the seed.
 *   - One `INSERT` statement per chunk row (never a giant multi-row INSERT),
 *     so bound params per statement stay tiny (a chunk row binds 3 values; the
 *     JSON payload lives inside a single text value, not as 100 placeholders).
 *   - `chunk_index` is UNIQUE, so this also converges under INSERT OR REPLACE.
 *
 * Usage:
 *   npx tsx scripts/seed-audience.ts                 # writes the SQL file
 *   npx tsx scripts/seed-audience.ts --out foo.sql   # custom output path
 *
 * Then apply it (see roadmap 3.3):
 *   npx wrangler d1 execute sms-campaigns-db --local  --file <out.sql>
 *   npx wrangler d1 execute sms-campaigns-db --remote --file <out.sql>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Provider bulk cap — matches `audience_chunks` sizing in tech.md §4. */
const CHUNK_SIZE = 100;

/** A clean UK mobile in E.164: `+447` followed by exactly 9 digits. */
const UK_MOBILE_E164 = /^\+447\d{9}$/;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_CSV = resolve(REPO_ROOT, "docs/data.csv");
const DEFAULT_OUT = resolve(REPO_ROOT, "scripts/audience_chunks.sql");

interface ParsedCsv {
  /** Clean, validated E.164 numbers in file order (duplicates preserved for reporting). */
  clean: string[];
  /** Rows dropped because the phone failed `UK_MOBILE_E164`. */
  dropped: Array<{ line: number; raw: string; phone: string }>;
  /** Total data rows seen (excluding header/blank lines). */
  totalRows: number;
}

/**
 * Minimal CSV line parser: the file has three unquoted columns per row and the
 * only quoting is in the known-corrupt line. We deliberately do **not** pull in
 * a CSV dependency (hard rule #5: no runtime CSV parser in the Worker; this
 * script stays dependency-free too). We split on the first two commas only, so
 * a stray comma inside the (unused) `visit_count` field cannot shift columns.
 */
function parseCsv(text: string): ParsedCsv {
  const lines = text.split("\n");
  const clean: string[] = [];
  const dropped: ParsedCsv["dropped"] = [];
  let totalRows = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (i === 0) continue; // header: customer_name,phone_e164,visit_count
    if (line.trim() === "") continue;
    totalRows++;

    // Columns are `customer_name,phone_e164,visit_count`. The phone is the
    // second column; take everything between the first and second comma, then
    // strip surrounding quotes/whitespace.
    const firstComma = line.indexOf(",");
    const secondComma = line.indexOf(",", firstComma + 1);
    const rawPhone =
      secondComma === -1
        ? line.slice(firstComma + 1)
        : line.slice(firstComma + 1, secondComma);

    const phone = rawPhone.trim().replace(/^"|"$/g, "").trim();

    if (UK_MOBILE_E164.test(phone)) {
      clean.push(phone);
    } else {
      dropped.push({ line: i + 1, raw: line, phone });
    }
  }

  return { clean, dropped, totalRows };
}

/** Split into groups of CHUNK_SIZE, preserving order. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Escape a string for a single-quoted SQLite literal. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function main(): void {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf("--out");
  const outPath = outFlag !== -1 ? resolve(args[outFlag + 1]) : DEFAULT_OUT;

  const csv = readFileSync(DEFAULT_CSV, "utf8");
  const { clean, dropped, totalRows } = parseCsv(csv);

  const chunks = chunk(clean, CHUNK_SIZE);
  const chunked = chunks.reduce((sum, c) => sum + c.length, 0);

  // ---- Sanity assertions: never emit a seed that silently loses data. ----
  if (clean.length === 0) {
    throw new Error("No clean phone numbers found — refusing to emit an empty seed.");
  }
  if (chunked !== clean.length) {
    throw new Error(`Chunking lost rows: ${chunked} != ${clean.length}`);
  }

  const statements: string[] = [];
  statements.push("-- Generated by scripts/seed-audience.ts — do not edit by hand.");
  statements.push(
    `-- Clean numbers: ${clean.length} of ${totalRows} data rows ` +
      `(${dropped.length} dropped). Chunks: ${chunks.length} @ ${CHUNK_SIZE}/chunk.`,
  );
  statements.push("");
  statements.push("-- Idempotent replace: re-running this seed fully resets the table.");
  statements.push("DELETE FROM audience_chunks;");
  statements.push("");

  for (let index = 0; index < chunks.length; index++) {
    const numbers = chunks[index];
    // One statement per row: binds 3 values, far under D1's 100-param limit.
    // The JSON array is a single text value, not 100 separate placeholders.
    const json = JSON.stringify(numbers);
    statements.push(
      "INSERT OR REPLACE INTO audience_chunks " +
        "(chunk_index, recipient_count, mobile_numbers_json) VALUES (" +
        `${index}, ${numbers.length}, ${sqlString(json)});`,
    );
  }

  writeFileSync(outPath, statements.join("\n") + "\n", "utf8");

  // ---- Report (surfaced to the operator running the seeder). ----
  console.log("Audience seeder");
  console.log(`  CSV:      ${DEFAULT_CSV}`);
  console.log(`  Output:   ${outPath}`);
  console.log(`  Data rows:        ${totalRows}`);
  console.log(`  Clean (kept):     ${clean.length}`);
  console.log(`  Dropped (dirty):  ${dropped.length}`);
  console.log(`  Chunks written:   ${chunks.length} (@ up to ${CHUNK_SIZE} each)`);
  const lastChunk = chunks[chunks.length - 1];
  console.log(`  Last chunk size:  ${lastChunk ? lastChunk.length : 0}`);
  if (dropped.length > 0) {
    console.log("\nDropped rows (not seeded):");
    for (const d of dropped) {
      console.log(`  line ${d.line}: phone=${JSON.stringify(d.phone)}  <<  ${d.raw}`);
    }
  }
}

main();
