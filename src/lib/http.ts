/**
 * Tiny HTTP helpers shared by the Phase 6 route handlers.
 *
 * Kept deliberately small and dependency-free (hard rule #1/#5): a single JSON-body reader
 * with a typed failure so every route reports malformed input consistently instead of each
 * one inventing its own parse/error handling.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * A handler outcome: either a success `value` or a ready-to-send error. Routes return
 * `c.json(...)` for the error branch and continue with `value` otherwise. Using a
 * discriminated union keeps the control flow obvious and avoids throwing for expected
 * validation failures.
 */
export type HandlerResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: ContentfulStatusCode; body: unknown };

/** Shorthand for an error outcome. */
export function fail(
  status: ContentfulStatusCode,
  body: unknown,
): { ok: false; status: ContentfulStatusCode; body: unknown } {
  return { ok: false, status, body };
}

/**
 * Read and parse a JSON request body. Returns a `400` outcome (not a throw) when the body is
 * missing, empty, or not valid JSON, so callers can early-return it unchanged.
 */
export async function readJsonBody(
  c: Context,
): Promise<HandlerResult<Record<string, unknown>>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return fail(400, { error: "bad_request", message: "Request body must be valid JSON." });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(400, { error: "bad_request", message: "Request body must be a JSON object." });
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Read an optional string field, returning `undefined` when absent or not a string. */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a string field or `""` when absent (callers then validate emptiness). */
export function requiredString(body: Record<string, unknown>, key: string): string {
  return optionalString(body, key) ?? "";
}
