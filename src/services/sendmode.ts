/**
 * Sendmode SMS REST API v3.0 — typed service layer.
 *
 * This is the **only** place that talks to the provider. It is a thin, dependency-free
 * wrapper over `fetch` so it runs unchanged in the Worker (HTTP routes and the queue
 * consumer) and in unit tests. Contract source of truth: `docs/sms-api.md`.
 *
 * Hard rules encoded here (agent.md #6, tech.md §7):
 *   - Base URL is `https://sms-rest.sendmode.dev`; every path is `/3.0/...`.
 *   - Auth is a **bare** `Authorization: {ACCESS_KEY}` header — never `Bearer `.
 *   - Every request that carries a body (including `DELETE /3.0/schedule`) sends
 *     `Content-Type: application/json` and a JSON body.
 *
 * What this file deliberately does NOT do:
 *   - It never decides retry/terminal semantics. A non-2xx response (or a transport
 *     failure) is surfaced as a typed, discriminated `SendmodeResult` so callers (the
 *     queue consumer in Phase 7) can apply the `200 / 400 / 401 / 429 / 5xx` policy.
 *   - It never loops. Fan-out over many batches goes through the queue, not `fetch()` in
 *     a request loop (hard rule #3). Each call here is exactly one provider request.
 */

/** Provider base URL — `docs/sms-api.md` §1 (authoritative; note the `sms-rest` host). */
export const SENDMODE_BASE_URL = "https://sms-rest.sendmode.dev";

/** Provider API version prefix for every path. */
export const SENDMODE_API_VERSION = "3.0";

/**
 * Credentials needed to call Sendmode. Kept as a structural type (rather than the Worker
 * `Env`) so this module has no Cloudflare dependency and stays trivially testable. The
 * caller passes `{ accessKey: env.SENDMODE_ACCESS_KEY }`.
 */
export interface SendmodeConfig {
  /** Sendmode access key; sent verbatim as the `Authorization` header value. */
  accessKey: string;
  /** Optional fetch implementation (defaults to global `fetch`); injectable for tests. */
  fetch?: typeof fetch;
  /** Optional base URL override (defaults to the production base URL); injectable for tests. */
  baseUrl?: string;
}

/** One destination in a bulk send/schedule call. */
export interface BulkSmsPayload {
  /** Displayed sender ID (1–15 chars, no `<>`). */
  senderId: string;
  /** SMS body (1–1224 chars, no `<>`). */
  message: string;
  /** Recipients in international format. Provider caps this array at 100 items. */
  mobileNumbers: string[];
  /** Optional caller tracking id (we use `batch.id`); echoed back in webhooks. */
  customerId?: string | null;
  /** Optional labels for reporting (we send `[campaign.name]`). */
  tags?: string[];
  /** Optional idempotency/reference id. */
  requestReference?: string | null;
}

/**
 * Why a call failed, coarse enough to drive the Phase 7 retry policy:
 *   - `"bad_request"` / `"unauthorized"` → non-retryable (mark the batch `FAILED`).
 *   - `"rate_limited"` / `"server_error"` / `"network"` → transient (retry).
 *   - `"invalid_response"` → provider answered 2xx with an unusable body; non-retryable
 *     (retrying identically cannot help until the contract changes).
 */
export type SendmodeFailureReason =
  | "bad_request"
  | "unauthorized"
  | "rate_limited"
  | "server_error"
  | "network"
  | "invalid_response";

/**
 * Discriminated result. `ok: true` always carries the provider's success payload; `ok:
 * false` carries a coarse `reason` plus a safe, human-readable `message` (never a raw
 * stack or secret — tech.md §9.6).
 */
export type SendmodeResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; reason: SendmodeFailureReason; message: string };

/** Base response fields every endpoint returns (docs/sms-api.md §4). */
interface BaseResponse {
  is_successful: boolean;
  error_message: string | null;
  accept_date: string | null;
}

/** `GET /3.0/balance` → 200 (docs/sms-api.md §5.1). */
export interface BalanceResponse extends BaseResponse {
  balance: number;
}

/** `POST /3.0/send/bulk` and `POST /3.0/schedule/bulk` → 200 (docs/sms-api.md §5.3, §5.5). */
export interface BulkSmsResponse extends BaseResponse {
  /** Any submitted numbers the provider judged invalid and skipped. */
  invalid_mobile_numbers: string[];
  /** UUID of the accepted bulk request; cancellation needs this for scheduled sends. */
  request_id: string;
}

/** `DELETE /3.0/schedule` → 200 (docs/sms-api.md §5.6). */
export type CancelScheduleResponse = BaseResponse;

/** Minimal shape check for a provider JSON body. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Classify a failed HTTP status into a retry reason. Mirrors the Phase 7 policy
 * (tech.md §8 / roadmap 7.4):
 *   400 / 401 → non-retryable; 429 → rate-limited; 5xx (and anything else) → server error.
 */
function classifyStatus(status: number): SendmodeFailureReason {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  return "server_error";
}

/**
 * Build the headers for a provider call. Auth is bare (`{ACCESS_KEY}`), and we always
 * declare a JSON body — required even for `DELETE /3.0/schedule`.
 */
function buildHeaders(config: SendmodeConfig): Record<string, string> {
  return {
    Authorization: config.accessKey,
    "Content-Type": "application/json",
  };
}

/** Resolve the effective fetch + base URL, honouring test overrides. */
function resolveTransport(config: SendmodeConfig): { doFetch: typeof fetch; url: (path: string) => string } {
  const doFetch = config.fetch ?? fetch;
  const base = (config.baseUrl ?? SENDMODE_BASE_URL).replace(/\/+$/, "");
  return { doFetch, url: (path: string) => `${base}/${SENDMODE_API_VERSION}${path}` };
}

/**
 * Perform one provider request and normalize the outcome into a `SendmodeResult`.
 *
 * `validate` receives the parsed JSON on a 2xx response and either returns the typed
 * payload or throws — a throw becomes an `invalid_response` failure (a 2xx whose body we
 * cannot trust must not be mistaken for success).
 */
async function request<T>(
  config: SendmodeConfig,
  init: { method: string; path: string; body?: unknown },
  validate: (data: unknown) => T,
): Promise<SendmodeResult<T>> {
  const { doFetch, url } = resolveTransport(config);

  let response: Response;
  try {
    response = await doFetch(url(init.path), {
      method: init.method,
      headers: buildHeaders(config),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown network error";
    return { ok: false, status: null, reason: "network", message: `Sendmode request failed: ${message}` };
  }

  // Parse the body defensively; the provider always returns JSON, but a proxy/gateway 5xx
  // may return HTML. A parse failure on a non-2xx is fine (we key off the status); on a
  // 2xx it becomes an `invalid_response`.
  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = await response.json();
  } catch {
    parseFailed = true;
  }

  if (!response.ok) {
    const providerError =
      isRecord(parsed) && typeof parsed.error_message === "string" ? parsed.error_message : null;
    return {
      ok: false,
      status: response.status,
      reason: classifyStatus(response.status),
      message: providerError ?? `Sendmode responded with HTTP ${response.status}`,
    };
  }

  if (parseFailed) {
    return {
      ok: false,
      status: response.status,
      reason: "invalid_response",
      message: "Sendmode returned a non-JSON body",
    };
  }

  try {
    return { ok: true, status: response.status, data: validate(parsed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected response shape";
    return { ok: false, status: response.status, reason: "invalid_response", message };
  }
}

/** Assert a base response and a boolean `is_successful` field; throw on mismatch. */
function assertBase(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) throw new Error("response was not a JSON object");
  if (typeof data.is_successful !== "boolean") throw new Error("missing boolean `is_successful`");
  return data;
}

/** Read the shared base fields into the typed shape. */
function readBase(base: Record<string, unknown>): BaseResponse {
  return {
    is_successful: base.is_successful as boolean,
    error_message: typeof base.error_message === "string" ? base.error_message : null,
    accept_date: typeof base.accept_date === "string" ? base.accept_date : null,
  };
}

/**
 * `GET /3.0/balance` — current SMS credit balance (docs/sms-api.md §5.1).
 *
 * The provider returns HTTP 200 with `is_successful: true` on success. A 200 with
 * `is_successful: false` is still surfaced as `ok: true` (contract-valid); callers should
 * check `data.balance`. We only fail on transport/status/shape problems.
 */
export function getBalance(config: SendmodeConfig): Promise<SendmodeResult<BalanceResponse>> {
  return request(config, { method: "GET", path: "/balance" }, (data) => {
    const base = assertBase(data);
    if (typeof base.balance !== "number" || !Number.isFinite(base.balance)) {
      throw new Error("missing numeric `balance`");
    }
    return { ...readBase(base), balance: base.balance };
  });
}

/** Validate a bulk send/schedule response body (`invalid_mobile_numbers` + `request_id`). */
function validateBulk(data: unknown): BulkSmsResponse {
  const base = assertBase(data);
  if (!Array.isArray(base.invalid_mobile_numbers)) throw new Error("missing `invalid_mobile_numbers` array");
  if (typeof base.request_id !== "string") throw new Error("missing `request_id`");
  return {
    ...readBase(base),
    invalid_mobile_numbers: base.invalid_mobile_numbers.filter((n): n is string => typeof n === "string"),
    request_id: base.request_id,
  };
}

/** Map our camelCase payload to the provider's snake_case body. */
function toProviderBulkBody(payload: BulkSmsPayload, scheduleDate?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sender_id: payload.senderId,
    message: payload.message,
    mobile_numbers: payload.mobileNumbers,
  };
  if (payload.customerId !== undefined) body.customer_id = payload.customerId;
  if (payload.tags !== undefined) body.tags = payload.tags;
  if (payload.requestReference !== undefined) body.request_reference = payload.requestReference;
  if (scheduleDate !== undefined) body.schedule_date = scheduleDate;
  return body;
}

/**
 * `POST /3.0/send/bulk` — send now to up to 100 recipients (docs/sms-api.md §5.3).
 * Emits one provider request per call; the caller is responsible for chunking to ≤100.
 */
export function sendBulk(config: SendmodeConfig, payload: BulkSmsPayload): Promise<SendmodeResult<BulkSmsResponse>> {
  return request(config, { method: "POST", path: "/send/bulk", body: toProviderBulkBody(payload) }, validateBulk);
}

/**
 * `POST /3.0/schedule/bulk` — schedule for a future UTC `schedule_date` (docs/sms-api.md
 * §5.5). `scheduleDate` must already be an ISO 8601 UTC string (`Z`), on a 15-minute slot
 * with `:00` seconds, ≥20 min ahead — `src/lib/uk-time.ts` guarantees that.
 */
export function scheduleBulk(
  config: SendmodeConfig,
  payload: BulkSmsPayload,
  scheduleDate: string,
): Promise<SendmodeResult<BulkSmsResponse>> {
  return request(
    config,
    { method: "POST", path: "/schedule/bulk", body: toProviderBulkBody(payload, scheduleDate) },
    validateBulk,
  );
}

/**
 * `DELETE /3.0/schedule` — cancel a scheduled single/bulk job by `request_id`
 * (docs/sms-api.md §5.6). Requires a JSON body + `Content-Type: application/json` even
 * though it is a DELETE (the provider quirk called out in agent.md #6).
 */
export function cancelSchedule(
  config: SendmodeConfig,
  requestId: string,
): Promise<SendmodeResult<CancelScheduleResponse>> {
  return request(config, { method: "DELETE", path: "/schedule", body: { request_id: requestId } }, (data) => {
    const base = assertBase(data);
    return readBase(base);
  });
}
