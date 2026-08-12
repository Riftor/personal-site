import { getDb } from '../db';
import { tier } from '../db/schema';
import { visibleDetailFor, type VisibleCalendarDetail } from './redact';
import { calendarViewFor } from './view';

/**
 * The Cron Trigger's work (plan §4): keep every cache variant warm so a human
 * visit is almost always a hit.
 *
 * This is a **warmer, not the source of truth**. A cold request still reads
 * live, so nothing here is on the path between a visitor and their calendar
 * and a cron that never fires costs latency, not correctness. That is also why
 * every failure below is logged and counted rather than thrown: one variant
 * failing must not stop the others being warmed.
 */

/**
 * Above this, a variant is warmed hourly rather than every quarter hour. Plan
 * §4: the year-long payload changes far less per unit time than the 30- and
 * 90-day ones, and warming it four times an hour spends subrequests and CPU
 * for nothing.
 */
export const SHORT_HORIZON_MAX_DAYS = 90;

/** Must match the `[triggers]` schedules in `wrangler.toml`. */
export const QUARTER_HOURLY_CRON = '*/15 * * * *';
export const HOURLY_CRON = '0 * * * *';

export type CalendarVariant = { detail: VisibleCalendarDetail; horizonDays: number };

/**
 * The distinct (detail, horizon) pairs the `tier` table actually asks for.
 *
 * Read from the database rather than hard-coded, because `tier` is the
 * authority on both columns — a horizon changed there takes effect without a
 * deploy, and the warmer must warm the keys the page will go looking for.
 * Rows that do not describe a renderable variant are skipped: `public` is
 * `none`, and anything else that lands here is a hand-edited row.
 */
export async function calendarVariants(d1: D1Database): Promise<CalendarVariant[]> {
	let rows;

	try {
		rows = await getDb(d1)
			.select({ detail: tier.calendarDetail, horizonDays: tier.calendarHorizonDays })
			.from(tier);
	} catch (cause) {
		console.error('calendar: could not read the tier table; nothing will be warmed.', cause);
		return [];
	}

	const variants = new Map<string, CalendarVariant>();

	for (const row of rows) {
		const detail = visibleDetailFor(row.detail);
		const horizonDays = row.horizonDays;
		if (!detail) continue;
		if (typeof horizonDays !== 'number' || !Number.isInteger(horizonDays) || horizonDays <= 0) {
			continue;
		}

		variants.set(`${detail}/${horizonDays}`, { detail, horizonDays });
	}

	return [...variants.values()];
}

/**
 * Which variants a given schedule is responsible for.
 *
 * An unrecognised cron expression warms the cheap half. The expensive one is
 * the 365-day fetch, and a mis-typed schedule should not be the thing that
 * starts running it every minute.
 */
export function variantsForCron(
	variants: readonly CalendarVariant[],
	cron: string | undefined
): CalendarVariant[] {
	const wantsLong = cron === HOURLY_CRON;
	return variants.filter(({ horizonDays }) =>
		wantsLong ? horizonDays > SHORT_HORIZON_MAX_DAYS : horizonDays <= SHORT_HORIZON_MAX_DAYS
	);
}

export type WarmOptions = {
	env: Env;
	/** `ScheduledController.cron`. Decides which variants are in scope. */
	cron?: string;
	now?: number;
	fetch?: typeof fetch;
};

export type WarmResult = { warmed: number; unavailable: number };

/** Warms every variant this schedule owns. Never throws. */
export async function warmCalendar(options: WarmOptions): Promise<WarmResult> {
	const variants = variantsForCron(await calendarVariants(options.env.DB), options.cron);
	const result: WarmResult = { warmed: 0, unavailable: 0 };

	for (const { detail, horizonDays } of variants) {
		const view = await calendarViewFor({
			env: options.env,
			detail,
			horizonDays,
			now: options.now,
			fetch: options.fetch
		});

		if (view.status === 'fresh') result.warmed += 1;
		else result.unavailable += 1;
	}

	console.log(
		`calendar: warmed ${result.warmed}/${variants.length} variants for cron "${options.cron ?? 'none'}".`
	);

	return result;
}
