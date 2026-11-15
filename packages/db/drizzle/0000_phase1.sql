CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`booth_id` text,
	`device_id` text,
	`actor_id` text,
	`actor_role` text,
	`action` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`data` text,
	`prev_hash` text,
	`hash` text NOT NULL,
	`server_seq` integer
);
--> statement-breakpoint
CREATE INDEX `audit_action_entity_at` ON `audit_logs` (`action`,`entity_id`,`at`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`public_token` text NOT NULL,
	`pin_hash` text NOT NULL,
	`event_id` text NOT NULL,
	`booth_id` text NOT NULL,
	`slot_id` text,
	`customer_id` text NOT NULL,
	`package_id` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`party_size` integer DEFAULT 1 NOT NULL,
	`hold_expires_at` integer,
	`checked_in_at` integer,
	`checked_in_by` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checked_in_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_code_unique` ON `bookings` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_public_token_unique` ON `bookings` (`public_token`);--> statement-breakpoint
CREATE INDEX `bookings_booth_status` ON `bookings` (`booth_id`,`status`);--> statement-breakpoint
CREATE TABLE `cameras` (
	`id` text PRIMARY KEY NOT NULL,
	`booth_id` text NOT NULL,
	`name` text NOT NULL,
	`driver` text DEFAULT 'auto' NOT NULL,
	`armed_session_id` text,
	`armed_by` text,
	`armed_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`armed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cameras_booth_name` ON `cameras` (`booth_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `cameras_armed_session` ON `cameras` (`armed_session_id`) WHERE armed_session_id is not null;--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`full_name` text,
	`email` text,
	`locale` text DEFAULT 'fr' NOT NULL,
	`whatsapp_opt_in` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer
);
--> statement-breakpoint
CREATE INDEX `customers_phone` ON `customers` (`phone`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`package_id` text,
	`photo_id` text,
	`kind` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price_xof` integer NOT NULL,
	`line_total_xof` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`booth_id` text,
	`channel` text NOT NULL,
	`cashier_id` text,
	`status` text NOT NULL,
	`subtotal_xof` integer DEFAULT 0 NOT NULL,
	`credit_applied_xof` integer DEFAULT 0 NOT NULL,
	`total_xof` integer DEFAULT 0 NOT NULL,
	`vat_bp` integer NOT NULL,
	`vat_xof` integer DEFAULT 0 NOT NULL,
	`paid_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cashier_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `photo_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`booth_id` text NOT NULL,
	`camera_id` text,
	`code` text NOT NULL,
	`dispatched_by` text,
	`photographer_id` text,
	`status` text NOT NULL,
	`armed_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dispatched_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`photographer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`seq` integer NOT NULL,
	`original_name` text NOT NULL,
	`file_name` text NOT NULL,
	`raw_file_name` text,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`taken_at` integer,
	`ingest_status` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`preview_key` text,
	`deliverable_key` text,
	`upload_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`session_id`) REFERENCES `photo_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_session_seq` ON `photos` (`session_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `photos_session_sha` ON `photos` (`session_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `print_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`booth_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`print_size` text NOT NULL,
	`custom_inches` text,
	`copies` integer DEFAULT 1 NOT NULL,
	`printer_name` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`requested_by` text,
	`printed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `print_jobs_status` ON `print_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staff_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tbl` text NOT NULL,
	`row_id` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_user_id` text,
	`full_name` text NOT NULL,
	`phone` text,
	`email` text,
	`role` text NOT NULL,
	`pin_hash` text,
	`locale` text DEFAULT 'fr' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`server_seq` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_user_id_unique` ON `users` (`auth_user_id`);