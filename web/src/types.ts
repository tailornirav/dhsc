/**
 * Shared API types for the dashboard — the client-side mirror of the response shapes emitted by
 * the Worker's Phase 6 routes (`src/routes/*.ts`). snake/camel-cased exactly as the API returns
 * them; keep in sync if a route changes.
 */

/** Campaign status machine (tech.md §4 — do not invent new values). */
export type CampaignStatus =
  | "QUEUED"
  | "PROCESSING"
  | "SENT"
  | "SCHEDULED"
  | "CANCELLING"
  | "CANCELLED"
  | "PARTIAL_FAILURE";

/** A campaign row as `GET /api/campaigns` / `GET /api/campaigns/:id` returns it (camelCase). */
export interface Campaign {
  id: string;
  name: string;
  senderId: string;
  message: string;
  mode: "IMMEDIATE" | "SCHEDULED";
  scheduleDate: string | null;
  status: CampaignStatus;
  totalRecipients: number;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  invalidCount: number;
  estimatedCredits: number;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A per-batch progress/error row from `GET /api/campaigns/:id`. */
export interface CampaignBatch {
  id: string;
  chunkIndex: number;
  status: "PENDING" | "SENT" | "SCHEDULED" | "CANCELLED" | "FAILED";
  requestId: string | null;
  invalidNumbers: string[];
  error: string | null;
}

/** `GET /api/balance` → 200. */
export interface BalanceResponse {
  balance: number;
  audience_count: number;
}

/** `GET /api/campaigns` → 200. */
export interface CampaignListResponse {
  filter: "upcoming" | "history";
  campaigns: Campaign[];
}

/** `GET /api/campaigns/:id` → 200. */
export interface CampaignDetailResponse {
  campaign: Campaign;
  batches: CampaignBatch[];
}

/** `GET /api/opt-outs` → 200. */
export interface OptOutsResponse {
  count: number;
  validRecipientCount: number;
  optOuts: Array<{ number: string; createdAt: string }>;
}

/** `POST /api/campaigns` → 202. */
export interface CreateCampaignResponse {
  id: string;
  status: "QUEUED";
  totalRecipients: number;
  totalBatches: number;
  estimatedCredits: number;
}

/** `POST /api/campaigns/:id/cancel` → 202. */
export interface CancelCampaignResponse {
  id: string;
  status: "CANCELLING";
  enqueued: number;
}

/** `POST /api/test-sms` → 202. */
export interface TestSmsResponse {
  id: string;
  batchId: string;
  status: "QUEUED";
  recipient: string;
  message: string;
  estimatedCredits: number;
}

/** `POST /api/opt-outs` and `DELETE /api/opt-outs/:number` → 200/201. */
export interface OptOutMutationResponse {
  number: string;
  added?: boolean;
  removed?: boolean;
  validRecipientCount: number;
}

/** A field-keyed validation issue (matches `ValidationIssue` in the Worker). */
export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

/** Any non-2xx error body the API can return. */
export interface ApiErrorBody {
  error: string;
  message?: string;
  reason?: string;
  issues?: ValidationIssue[];
  required?: number;
  available?: number;
}
