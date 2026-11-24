import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * D1 / SQLite schema for DHSC.
 *
 * This is a faithful mirror of `docs/tech.md` §4. Drizzle-kit emits the actual
 * migration SQL into `src/db/migrations` from these definitions — keep the two in
 * sync (authority order: `docs/sms-api.md` > `docs/tech.md` > `docs/mission.md`).
 */

/**
 * Pre-chunked, static audience (81 rows: 80×100 + 1×60 for 8,060 clean numbers).
 * Seeded once by `scripts/seed-audience.ts`; never edited in-app.
 */
export const audienceChunks = sqliteTable("audience_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chunkIndex: integer("chunk_index").notNull().unique(),
  recipientCount: integer("recipient_count").notNull(),
  // JSON array of up to 100 E.164 strings (e.g. ["+447700900077", ...]).
  mobileNumbersJson: text("mobile_numbers_json").notNull(),
});

/**
 * Campaign metadata. Drives the Queued & History views.
 *
 * `status` values (do not invent new ones):
 *   QUEUED | PROCESSING | SENT | SCHEDULED | CANCELLING | CANCELLED | PARTIAL_FAILURE
 */
export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(), // UUID
  name: text("name").notNull(),
  senderId: text("sender_id").notNull(), // provisioned sender ID; <=11 chars, no <>
  message: text("message").notNull(), // operator text; suffix appended first; <=160 (GSM-7)
  mode: text("mode").notNull(), // 'IMMEDIATE' | 'SCHEDULED'
  scheduleDate: text("schedule_date"), // ISO 8601 UTC ('2026-12-01T14:00:00Z') or NULL
  status: text("status").notNull(), // see status machine above
  totalRecipients: integer("total_recipients").notNull(),
  totalBatches: integer("total_batches").notNull(),
  completedBatches: integer("completed_batches").notNull().default(0),
  failedBatches: integer("failed_batches").notNull().default(0),
  invalidCount: integer("invalid_count").notNull().default(0),
  estimatedCredits: integer("estimated_credits").notNull(),
  // Marks a single test send so History can label it (mission.md §8.6 / roadmap 6.6).
  isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Per-batch provider tracking. Enables safe retries and cancellation.
 *
 * `status` values (do not invent new ones):
 *   PENDING | SENT | SCHEDULED | CANCELLED | FAILED
 */
export const campaignBatches = sqliteTable(
  "campaign_batches",
  {
    id: text("id").primaryKey(), // UUID
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    chunkIndex: integer("chunk_index").notNull(),
    status: text("status").notNull(), // 'PENDING'|'SENT'|'SCHEDULED'|'CANCELLED'|'FAILED'
    sendmodeRequestId: text("sendmode_request_id"), // needed for DELETE /3.0/schedule
    invalidNumbersJson: text("invalid_numbers_json"), // JSON array from Sendmode response
    errorMessage: text("error_message"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_batches_campaign").on(table.campaignId, table.status)],
);

/**
 * Opt-out blacklist. Numbers here are always stripped from every audience.
 * Written by the (public, rate-limited) opt-out route and read by audience
 * computation; managed from the authenticated Opt-Outs modal otherwise.
 */
export const optOuts = sqliteTable("opt_outs", {
  mobileNumber: text("mobile_number").primaryKey(),
  createdAt: text("created_at").notNull(),
});
