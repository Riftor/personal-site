import { describe, expect, it } from 'vitest';
import {
	HOURLY_CRON,
	QUARTER_HOURLY_CRON,
	SHORT_HORIZON_MAX_DAYS,
	variantsForCron,
	type CalendarVariant
} from './warm';

/**
 * Which schedule owns which variant (plan §4). The 30- and 90-day bands are
 * cheap and warm every quarter hour; the 365-day one is a ten-page fetch and
 * warms hourly.
 */

const VARIANTS: CalendarVariant[] = [
	{ detail: 'busy', horizonDays: 30 },
	{ detail: 'titles', horizonDays: 90 },
	{ detail: 'full', horizonDays: 365 }
];

describe('variantsForCron', () => {
	it('warms the short bands every quarter hour', () => {
		expect(variantsForCron(VARIANTS, QUARTER_HOURLY_CRON)).toEqual([
			{ detail: 'busy', horizonDays: 30 },
			{ detail: 'titles', horizonDays: 90 }
		]);
	});

	it('warms the year-long band hourly, and only hourly', () => {
		expect(variantsForCron(VARIANTS, HOURLY_CRON)).toEqual([{ detail: 'full', horizonDays: 365 }]);
	});

	it('covers every variant exactly once across the two schedules', () => {
		expect([
			...variantsForCron(VARIANTS, QUARTER_HOURLY_CRON),
			...variantsForCron(VARIANTS, HOURLY_CRON)
		]).toEqual(expect.arrayContaining(VARIANTS));
	});

	/**
	 * A cron string nobody recognises falls to the cheap half. The expensive
	 * one is the year-long fetch, and a typo in `wrangler.toml` should not be
	 * the thing that starts running it every minute.
	 */
	it('falls back to the short bands for an unrecognised schedule', () => {
		for (const cron of ['* * * * *', '', undefined]) {
			expect(
				variantsForCron(VARIANTS, cron).every(
					({ horizonDays }) => horizonDays <= SHORT_HORIZON_MAX_DAYS
				)
			).toBe(true);
		}
	});
});
