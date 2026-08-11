CREATE TABLE `media_asset` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text,
	`kind` text NOT NULL,
	`original_key` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_s` real,
	`blurhash` text,
	`caption` text,
	`taken_at` integer,
	`min_tier_rank` integer DEFAULT 100 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `content_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_asset_kind_check" CHECK("media_asset"."kind" in ('image', 'video'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_asset_original_key_unique` ON `media_asset` (`original_key`);--> statement-breakpoint
CREATE INDEX `idx_asset_entry` ON `media_asset` (`entry_id`,`position`);--> statement-breakpoint
CREATE TABLE `media_variant` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`variant` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	FOREIGN KEY (`asset_id`) REFERENCES `media_asset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_variant_r2_key_unique` ON `media_variant` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_variant_asset_variant` ON `media_variant` (`asset_id`,`variant`);