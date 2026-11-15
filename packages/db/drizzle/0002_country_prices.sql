DROP INDEX `packages_code_unique`;--> statement-breakpoint
ALTER TABLE `packages` ADD `country` text DEFAULT 'SN' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `packages_code_country` ON `packages` (`code`,`country`);