CREATE TABLE `audience_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chunk_index` integer NOT NULL,
	`recipient_count` integer NOT NULL,
	`mobile_numbers_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_chunks_chunk_index_unique` ON `audience_chunks` (`chunk_index`);--> statement-breakpoint
CREATE TABLE `campaign_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`status` text NOT NULL,
	`sendmode_request_id` text,
	`invalid_numbers_json` text,
	`error_message` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_batches_campaign` ON `campaign_batches` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sender_id` text NOT NULL,
	`message` text NOT NULL,
	`mode` text NOT NULL,
	`schedule_date` text,
	`status` text NOT NULL,
	`total_recipients` integer NOT NULL,
	`total_batches` integer NOT NULL,
	`completed_batches` integer DEFAULT 0 NOT NULL,
	`failed_batches` integer DEFAULT 0 NOT NULL,
	`invalid_count` integer DEFAULT 0 NOT NULL,
	`estimated_credits` integer NOT NULL,
	`is_test` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `opt_outs` (
	`mobile_number` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
