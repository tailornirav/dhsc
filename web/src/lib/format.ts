/**
 * Small presentation helpers shared across the dashboard. Kept pure and dependency-free so they
 * are trivial to reason about and reuse.
 */

/** Group-separated integer, e.g. `8060` → `8,060`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.trunc(value).toLocaleString("en-GB");
}

/** Credits with the unit suffix, e.g. `1,238 credits` (singular-aware). */
export function formatCredits(value: number): string {
  const n = Math.trunc(value);
  return `${formatCount(n)} ${n === 1 ? "credit" : "credits"}`;
}

/** Join conditional class names, dropping falsy entries. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
