import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { desc, sql } from 'drizzle-orm';

/**
 * Better Auth's own `user` / `session` / `account` / `verification` tables.
 * Re-exported rather than redefined so drizzle-kit sees one schema module and
 * the Better Auth adapter and the app read the same table objects.
 */
export * from './auth-schema';

/** How much of Caden's calendar a tier is allowed to see. See plan §4. */
export const CALENDAR_DETAILS = ['none', 'busy', 'titles', 'full'] as const;
export type CalendarDetail = (typeof CALENDAR_DETAILS)[number];

/**
 * The five tiers, in rank order. The `tier` table is the authority on what
 * rank each one carries; this list only fixes the set of legal slugs so a
 * typo in a grant is a type error rather than a silently ungranted account.
 */
export const TIER_SLUGS = ['public', 'friend', 'family', 'partner', 'owner'] as const;
export type TierSlug = (typeof TIER_SLUGS)[number];

export const tier = sqliteTable(
	'tier',
	{
		slug: text('slug', { enum: TIER_SLUGS }).primaryKey(),
		name: text('name').notNull(),
		/** 0, 10, 20, 30, 100 — gaps so a new tier can be slotted between two existing ones. */
		rank: integer('rank').notNull().unique(),
		calendarDetail: text('calendar_detail', { enum: CALENDAR_DETAILS }).notNull().default('busy'),
		calendarHorizonDays: integer('calendar_horizon_days').notNull().default(30),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		check(
			'tier_calendar_detail_check',
			sql`${t.calendarDetail} in ('none', 'busy', 'titles', 'full')`
		)
	]
);

export type Tier = typeof tier.$inferSelect;

/** Rank a row must carry to be readable with no session at all. See plan §2. */
export const PUBLIC_TIER_RANK = 0;
/** Rank nothing but Caden's own account clears. The default for new content. */
export const OWNER_TIER_RANK = 100;

/**
 * Who may read the private half, keyed by EMAIL rather than by `user.id` so a
 * grant can exist before that person has ever signed in. That is what makes
 * "invite" work without an invite system (plan §3).
 *
 * Two properties this table has to keep, because the guard depends on both:
 * `email` is stored lowercased (the CLI in `scripts/access.mjs` is the only
 * writer and lowercases on the way in, and `resolveViewer` lowercases on the
 * way out), and revocation is a soft `revoked_at` stamp — so every read of
 * this table must filter on `revoked_at IS NULL` or a revoked row grants
 * access again.
 */
export const accessGrant = sqliteTable(
	'access_grant',
	{
		/** Lowercased. Primary key: one live tier per address, never a list. */
		email: text('email').primaryKey(),
		tierSlug: text('tier_slug', { enum: TIER_SLUGS })
			.notNull()
			.references(() => tier.slug),
		/** Free text for Caden — 'girlfriend', 'mum', 'uni friend'. */
		note: text('note'),
		grantedAt: integer('granted_at').notNull(),
		grantedBy: text('granted_by'),
		/** Soft revoke. NULL means active; anything else means no access. */
		revokedAt: integer('revoked_at')
	},
	(t) => [
		index('idx_grant_active')
			.on(t.email)
			.where(sql`${t.revokedAt} is null`)
	]
);

export type AccessGrant = typeof accessGrant.$inferSelect;

/**
 * Actions worth a permanent record. `grant` and `revoke` are written by the
 * CLI from M3; the request-time actions land with the hardening pass in M8.
 */
export const AUDIT_ACTIONS = [
	'signin',
	'denied',
	'grant',
	'revoke',
	'media_fetch_denied',
	'publish'
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditLog = sqliteTable(
	'audit_log',
	{
		id: text('id').primaryKey(),
		at: integer('at').notNull(),
		/** An email, or 'system' / 'cli' when no human is attached. */
		actor: text('actor'),
		action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
		target: text('target'),
		/** JSON. Never a token, never media bytes, never a full IP (plan §8). */
		detail: text('detail'),
		/** /24 or /48 only — a full address is personal data (plan §8). */
		ipPrefix: text('ip_prefix')
	},
	(t) => [index('idx_audit_at').on(desc(t.at))]
);

export type AuditLogRow = typeof auditLog.$inferSelect;

/**
 * Which template renders an entry. `page` and `project` are the public
 * portfolio; the rest arrive with the private half in M3–M4.
 */
export const CONTENT_KINDS = ['page', 'project', 'memory', 'photoset', 'activity'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const CONTENT_STATUSES = ['draft', 'published'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const contentEntry = sqliteTable(
	'content_entry',
	{
		/** ULID. */
		id: text('id').primaryKey(),
		slug: text('slug').notNull().unique(),
		kind: text('kind', { enum: CONTENT_KINDS }).notNull(),
		title: text('title').notNull(),
		summary: text('summary'),
		/** Markdown source, synced from `content/` by the publish CLI (§6). */
		bodyMd: text('body_md'),
		/** Rendered at publish time so the Worker never parses markdown. */
		bodyHtml: text('body_html'),
		/** DEFAULT DENY — an explicit 0 is what makes a row public. */
		minTierRank: integer('min_tier_rank').notNull().default(OWNER_TIER_RANK),
		status: text('status', { enum: CONTENT_STATUSES }).notNull().default('draft'),
		/**
		 * References `media_asset(id)`; that table and the foreign key land with
		 * the media pipeline in M4. The column exists now so the publish CLI's
		 * row shape does not change under it.
		 */
		coverAssetId: text('cover_asset_id'),
		/** ISO date the entry is *about*, not when it was written. */
		occurredOn: text('occurred_on'),
		publishedAt: integer('published_at'),
		updatedAt: integer('updated_at').notNull(),
		/** Manual ordering override; ties are broken by `occurred_on`. */
		sortKey: text('sort_key')
	},
	(t) => [
		check(
			'content_entry_kind_check',
			sql`${t.kind} in ('page', 'project', 'memory', 'photoset', 'activity')`
		),
		check('content_entry_status_check', sql`${t.status} in ('draft', 'published')`),
		index('idx_entry_kind_pub').on(t.kind, t.status, t.minTierRank, desc(t.occurredOn))
	]
);

export type ContentEntry = typeof contentEntry.$inferSelect;
