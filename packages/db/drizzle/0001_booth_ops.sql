CREATE TABLE `cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`drawer_session_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_xof` integer NOT NULL,
	`payment_id` text,
	`by_user` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`drawer_session_id`) REFERENCES `drawer_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`by_user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`paired_by` text NOT NULL,
	`paired_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`paired_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `drawer_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`booth_id` text NOT NULL,
	`opened_by` text NOT NULL,
	`opened_at` integer NOT NULL,
	`opening_float_xof` integer NOT NULL,
	`closed_by` text,
	`closed_at` integer,
	`counted_xof` integer,
	`expected_xof` integer,
	`variance_xof` integer,
	`approved_by` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`code` text NOT NULL,
	`name_fr` text NOT NULL,
	`name_en` text NOT NULL,
	`price_xof` integer NOT NULL,
	`digitals_included` integer DEFAULT 0 NOT NULL,
	`prints` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packages_code_unique` ON `packages` (`code`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`method` text NOT NULL,
	`provider` text,
	`idempotency_key` text NOT NULL,
	`provider_tx_id` text,
	`amount_xof` integer NOT NULL,
	`payer_phone` text,
	`status` text NOT NULL,
	`received_by` text,
	`drawer_session_id` text,
	`confirmed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`drawer_session_id`) REFERENCES `drawer_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_key_unique` ON `payments` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_tx` ON `payments` (`method`,`provider_tx_id`);--> statement-breakpoint
CREATE TABLE `queue_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`booth_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`lane` text NOT NULL,
	`sort_at` integer NOT NULL,
	`manual_rank` integer,
	`status` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`called_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_entries_booking_id_unique` ON `queue_entries` (`booking_id`);--> statement-breakpoint
CREATE INDEX `queue_booth_status` ON `queue_entries` (`booth_id`,`status`);--> statement-breakpoint
CREATE TABLE `upload_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	`kind` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_jobs_photo_kind` ON `upload_jobs` (`photo_id`,`kind`);--> statement-breakpoint
ALTER TABLE `customers` ADD `country` text;--> statement-breakpoint
ALTER TABLE `order_items` ADD `print_size` text;