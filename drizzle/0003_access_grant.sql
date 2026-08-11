CREATE TABLE `access_grant` (
	`email` text PRIMARY KEY NOT NULL,
	`tier_slug` text NOT NULL,
	`note` text,
	`granted_at` integer NOT NULL,
	`granted_by` text,
	`revoked_at` integer,
	FOREIGN KEY (`tier_slug`) REFERENCES `tier`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_grant_active` ON `access_grant` (`email`) WHERE "access_grant"."revoked_at" is null;--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor` text,
	`action` text NOT NULL,
	`target` text,
	`detail` text,
	`ip_prefix` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_at` ON `audit_log` ("at" desc);--> statement-breakpoint
-- Bootstrap (plan §2, "Bootstrap / admin"). Caden's own grant is seeded here
-- rather than by the CLI so the highest-privilege row in the database exists
-- before anything is deployed, and so there is no HTTP path — and no first-run
-- setup page — that can mint an owner. Every other grant goes through
-- `pnpm access:grant`, which writes the matching `audit_log` row itself.
-- The address is lowercased because `resolveViewer` looks it up lowercased.
INSERT INTO `access_grant` (`email`, `tier_slug`, `note`, `granted_at`, `granted_by`, `revoked_at`)
VALUES ('cadenedam@gmail.com', 'owner', 'Caden — seeded by migration 0003', unixepoch(), 'system', NULL);
--> statement-breakpoint
INSERT INTO `audit_log` (`id`, `at`, `actor`, `action`, `target`, `detail`, `ip_prefix`)
VALUES (
	'01K3ZQ7B9C0000000000000101', unixepoch(), 'system', 'grant', 'cadenedam@gmail.com',
	'{"tier":"owner","source":"migration 0003_access_grant"}', NULL
);