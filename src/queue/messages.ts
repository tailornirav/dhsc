/**
 * Queue message contracts — the typed payloads that cross the HTTP → queue boundary.
 *
 * The producer (`src/index.ts` routes, Phase 6) is the **only** authenticated writer; the
 * consumer (`src/queue/*`, Phase 7) trusts these payloads because no anonymous request can
 * enqueue (tech.md §5 "Auth rule"). Both sides import from here so a field rename can never
 * drift between them.
 *
 * Every message matches tech.md §6: `{ type, campaignId, batchId, ... }`.
 */

/** Ask the consumer to send/schedule one campaign batch (`DISPATCH_BATCH`). */
export interface DispatchBatchMessage {
  type: "DISPATCH_BATCH";
  campaignId: string;
  batchId: string;
  /** Chunk row to send (its `mobile_numbers_json` is the recipient list). */
  chunkIndex: number;
  /**
   * Inline recipient list. Real campaigns leave this undefined and let the consumer read the
   * `audience_chunks` row named by `chunkIndex`. A **test send** has no chunk row (the number
   * is arbitrary and must never enter the static audience), so it supplies the single number
   * here instead.
   */
  recipients?: string[];
}

/**
 * Ask the consumer to cancel one scheduled provider job (`CANCEL_BATCH`). `requestId` is the
 * provider `request_id` captured when the batch was scheduled — `DELETE /3.0/schedule` needs
 * it (tech.md Flow B step 4).
 */
export interface CancelBatchMessage {
  type: "CANCEL_BATCH";
  campaignId: string;
  batchId: string;
  requestId: string;
}

/** Discriminated union of everything the consumer may receive. */
export type QueueMessage = DispatchBatchMessage | CancelBatchMessage;

/**
 * Provider bulk-cap (and our `audience_chunks` size). `Queue.sendBatch()` accepts at most
 * **100** messages per call, so producers slice jobs into groups of this size (hard rule #3).
 */
export const QUEUE_BATCH_LIMIT = 100;
