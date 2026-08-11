CREATE TABLE `content_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`body_md` text,
	`body_html` text,
	`min_tier_rank` integer DEFAULT 100 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`cover_asset_id` text,
	`occurred_on` text,
	`published_at` integer,
	`updated_at` integer NOT NULL,
	`sort_key` text,
	CONSTRAINT "content_entry_kind_check" CHECK("content_entry"."kind" in ('page', 'project', 'memory', 'photoset', 'activity')),
	CONSTRAINT "content_entry_status_check" CHECK("content_entry"."status" in ('draft', 'published'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_entry_slug_unique` ON `content_entry` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_entry_kind_pub` ON `content_entry` (`kind`,`status`,`min_tier_rank`,"occurred_on" desc);--> statement-breakpoint
-- Seed for the public portfolio (M1). Deliberately placeholder copy: the point
-- of these rows is that the D1 -> load -> render pipeline works end to end, not
-- that the words are final. Every string is marked [PLACEHOLDER] so nothing here
-- can be mistaken for real biography if the site is deployed before it is written.
-- `min_tier_rank = 0` is what makes a row readable with no session.
-- IDs are ULID-shaped; the trailing digits are the only meaningful part by hand.
INSERT INTO `content_entry`
	(`id`, `slug`, `kind`, `title`, `summary`, `body_html`, `min_tier_rank`, `status`, `occurred_on`, `sort_key`, `published_at`, `updated_at`)
VALUES
	(
		'01K3ZQ7B9C0000000000000001', 'home', 'page',
		'[PLACEHOLDER] One line that says what you do',
		'[PLACEHOLDER] — replace with a two-sentence lead: who you are, the kind of work you take on, and what a visitor should do next.',
		'<p>[PLACEHOLDER] — replace with a short intro paragraph. Two or three sentences is plenty; the work below is meant to carry the rest.</p>',
		0, 'published', NULL, '000', unixepoch(), unixepoch()
	),
	(
		'01K3ZQ7B9C0000000000000002', 'about', 'page',
		'About',
		'[PLACEHOLDER] — one line summarising the longer story below.',
		'<p>[PLACEHOLDER] — replace with the opening of the longer story: where you started, and what pulled you toward the work you do now.</p>'
		|| '<p>[PLACEHOLDER] — a second paragraph with more detail. This page is the one place on the site with room for prose, so it can afford to be slower than the home page.</p>'
		|| '<h2>[PLACEHOLDER] How I work</h2>'
		|| '<p>[PLACEHOLDER] — replace with a paragraph on method, or delete this heading entirely.</p>'
		|| '<ul><li>[PLACEHOLDER] — a thing that is true about how you work.</li>'
		|| '<li>[PLACEHOLDER] — another one.</li>'
		|| '<li>[PLACEHOLDER] — a third.</li></ul>'
		|| '<h2>[PLACEHOLDER] Elsewhere</h2>'
		|| '<p>[PLACEHOLDER] — replace with links to wherever you want to be found.</p>',
		0, 'published', NULL, '000', unixepoch(), unixepoch()
	),
	(
		'01K3ZQ7B9C0000000000000003', 'work', 'page',
		'Work',
		'[PLACEHOLDER] — one line framing the projects below.',
		'<p>[PLACEHOLDER] — replace with a paragraph on how you pick what to work on, or delete this and let the list speak for itself.</p>',
		0, 'published', NULL, '000', unixepoch(), unixepoch()
	),
	(
		'01K3ZQ7B9C0000000000000011', 'project-placeholder-one', 'project',
		'[PLACEHOLDER] Project One',
		'[PLACEHOLDER] — one or two sentences on what this project is, what you did on it, and what changed as a result.',
		NULL, 0, 'published', '2026-05-01', '010', unixepoch(), unixepoch()
	),
	(
		'01K3ZQ7B9C0000000000000012', 'project-placeholder-two', 'project',
		'[PLACEHOLDER] Project Two',
		'[PLACEHOLDER] — one or two sentences on what this project is, what you did on it, and what changed as a result.',
		NULL, 0, 'published', '2026-02-01', '020', unixepoch(), unixepoch()
	),
	(
		'01K3ZQ7B9C0000000000000013', 'project-placeholder-three', 'project',
		'[PLACEHOLDER] Project Three',
		'[PLACEHOLDER] — one or two sentences on what this project is, what you did on it, and what changed as a result.',
		NULL, 0, 'published', '2025-11-01', '030', unixepoch(), unixepoch()
	),
	(
		'01K3ZQ7B9C0000000000000014', 'project-placeholder-four', 'project',
		'[PLACEHOLDER] Project Four',
		'[PLACEHOLDER] — one or two sentences on what this project is, what you did on it, and what changed as a result.',
		NULL, 0, 'published', '2025-08-01', '040', unixepoch(), unixepoch()
	);
