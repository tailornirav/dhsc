/**
 * Typed fetch client for the Worker API.
 *
 * Every call goes to a same-origin `/api/*` path: in dev Vite proxies it to `wrangler dev`
 * (see `vite.config.ts`); in production the Worker serves both the SPA and the API. `credentials`
 * is `same-origin` so the Cloudflare Access session cookie rides along on gated requests
 * (tech.md §9.1) — the Worker trusts Access, so we must present its cookie.
 *
 * The client normalises the API's error envelope (`{ error, message?, issues? }`, tech.md §9.6)
 * into a single `ApiError` type so callers can distinguish a field validation failure (which
 * belongs inline on the form) from a provider/transport failure (which belongs in a toast).
 */

import type {
  ApiErrorBody,
  BalanceResponse,
  CancelCampaignResponse,
  CampaignDetailResponse,
  CampaignListResponse,
  CreateCampaignResponse,
  OptOutMutationResponse,
  OptOutsResponse,
  TestSmsResponse,
  ValidationIssue,
} from "./types";

/**
 * An error carrying the parsed API body plus the HTTP status. `issues` is present only for a
 * `validation_failed` (400) response; `error` is the machine-readable code.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];
  readonly required?: number;
  readonly available?: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error ?? "unknown_error";
    this.issues = body.issues ?? [];
    this.required = body.required;
    this.available = body.available;
  }

  /** True when the API rejected one or more form fields. */
  get isValidation(): boolean {
    return this.code === "validation_failed" && this.issues.length > 0;
  }
}

/** Perform one JSON request and parse the envelope, throwing `ApiError` on any non-2xx. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    // A transport failure (offline, proxy down, DNS) — surface as a synthetic 0-status error.
    const message = error instanceof Error ? error.message : "Network request failed";
    throw new ApiError(0, { error: "network_error", message });
  }

  if (response.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body on a failure is still a failure; synthesise a minimal error body.
    if (!response.ok) {
      throw new ApiError(response.status, {
        error: "invalid_response",
        message: `Request failed (${response.status}).`,
      });
    }
    return undefined as T;
  }

  if (!response.ok) {
    throw new ApiError(response.status, (body ?? {}) as ApiErrorBody);
  }
  return body as T;
}

/** `GET /api/balance` — live provider balance plus the current valid audience size. */
export function fetchBalance(): Promise<BalanceResponse> {
  return request<BalanceResponse>("/api/balance");
}

/** `GET /api/campaigns?filter=…` — campaigns for the Queued (`upcoming`) or History tab. */
export function fetchCampaigns(filter: "upcoming" | "history"): Promise<CampaignListResponse> {
  return request<CampaignListResponse>(`/api/campaigns?filter=${filter}`);
}

/** `GET /api/campaigns/:id` — one campaign with its per-batch progress. */
export function fetchCampaign(id: string): Promise<CampaignDetailResponse> {
  return request<CampaignDetailResponse>(`/api/campaigns/${encodeURIComponent(id)}`);
}

/** `POST /api/campaigns` — create + enqueue a campaign (returns `202`). */
export function createCampaign(input: {
  name: string;
  senderId: string;
  message: string;
  mode: "IMMEDIATE" | "SCHEDULED";
  scheduleLocal?: string;
  /** Pasted recipient list for a "specific numbers" send; omitted for "all contacts". */
  recipients?: string;
  /**
   * Client-generated UUID for create idempotency (Phase 13). Sent as `Idempotency-Key` so a
   * retry/resubmit of the *same* attempt replays the original result instead of creating a
   * second campaign (and a second spend). Kept constant across retries of one submission.
   */
  idempotencyKey?: string;
}): Promise<CreateCampaignResponse> {
  return request<CreateCampaignResponse>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
    headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {},
  });
}

/** `POST /api/campaigns/:id/cancel` — begin cancellation (returns `202`). */
export function cancelCampaign(id: string): Promise<CancelCampaignResponse> {
  return request<CancelCampaignResponse>(`/api/campaigns/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

/** `POST /api/test-sms` — send one unscheduled test SMS (returns `202`). */
export function sendTestSms(input: {
  senderId: string;
  message: string;
  to: string;
}): Promise<TestSmsResponse> {
  return request<TestSmsResponse>("/api/test-sms", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `GET /api/opt-outs` — the blacklist plus the resulting valid recipient count. */
export function fetchOptOuts(): Promise<OptOutsResponse> {
  return request<OptOutsResponse>("/api/opt-outs");
}

/** `POST /api/opt-outs` — add a number to the blacklist. */
export function addOptOut(number: string): Promise<OptOutMutationResponse> {
  return request<OptOutMutationResponse>("/api/opt-outs", {
    method: "POST",
    body: JSON.stringify({ number }),
  });
}

/** `DELETE /api/opt-outs/:number` — remove a number from the blacklist. */
export function removeOptOut(number: string): Promise<OptOutMutationResponse> {
  return request<OptOutMutationResponse>(`/api/opt-outs/${encodeURIComponent(number)}`, {
    method: "DELETE",
  });
}
