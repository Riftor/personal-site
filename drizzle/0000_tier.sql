CREATE TABLE `tier` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rank` integer NOT NULL,
	`calendar_detail` text DEFAULT 'busy' NOT NULL,
	`calendar_horizon_days` integer DEFAULT 30 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "tier_calendar_detail_check" CHECK("tier"."calendar_detail" in ('none', 'busy', 'titles', 'full'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tier_rank_unique` ON `tier` (`rank`);
--> statement-breakpoint
INSERT INTO `tier` (`slug`, `name`, `rank`, `calendar_detail`, `calendar_horizon_days`, `created_at`) VALUES
	('public',  'Public',    0, 'none',      0, unixepoch()),
	('friend',  'Friend',   10, 'busy',     30, unixepoch()),
	('family',  'Family',   20, 'titles',   90, unixepoch()),
	('partner', 'Partner',  30, 'full',    365, unixepoch()),
	('owner',   'Owner',   100, 'full',    365, unixepoch());