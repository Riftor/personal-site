import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/** How much of Caden's calendar a tier is allowed to see. See plan §4. */
export const CALENDAR_DETAILS = ['none', 'busy', 'titles', 'full'] as const;
export type CalendarDetail = (typeof CALENDAR_DETAILS)[number];

export const tier = sqliteTable(
	'tier',
	{
		slug: text('slug').primaryKey(),
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
