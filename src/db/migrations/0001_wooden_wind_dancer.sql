CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text NOT NULL
);
