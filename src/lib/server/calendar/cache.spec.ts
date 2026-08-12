import { describe, expect, it, vi } from 'vitest';
import { memoryCache } from '../testing/memory-cache';
import {
	CALENDAR_FRESH_SECONDS,
	CALENDAR_MAX_STALE_SECONDS,
	calendarCacheKey,
	readCalendar
} from './cache';
import type { CalendarPayload, VisibleCalendarDetail } from './redact';

/**
 * The M5.4 done-condition: two requests inside 300 s produce one upstream
 * call, and an upstream failure still yields something to render with a
 * staleness figure attached.
 */

const START = Date.parse('2026-08-12T09:00:00Z');

function payload(
	detail: VisibleCalendarDetail,
	horizonDays: number,
	fetchedAt: number,
	title = 'Sprint review'
): CalendarPayload {
	return {
		detail,
		horizonDays,
		timeZone: 'Europe/London',
		fetchedAt,
		truncated: false,
		blocks: [
			{
				start: '2026-08-12T14:00:00+01:00',
				end: '2026-08-12T15:00:00+01:00',
				allDay: false,
				title: detail === 'busy' ? null : title,
				location: null,
				description: null
			}
		]
	};
}

describe('calendarCacheKey', () => {
	it('separates every detail level and every horizon band', () => {
		const keys = [
			calendarCacheKey('busy', 30),
			calendarCacheKey('titles', 90),
			calendarCacheKey('full', 365)
		];

		expect(keys).toEqual([
			'https://cache.internal/calendar/busy/30',
			'https://cache.internal/calendar/titles/90',
			'https://cache.internal/calendar/full/365'
		]);
		expect(new Set(keys).size).toBe(3);
	});
});

describe('readCalendar', () => {
	/** The M5.4 done-condition. */
	it('serves the second request inside 300 s from the cache', async () => {
		const cache = memoryCache(() => START);
		const load = vi.fn(async () => payload('busy', 30, START));

		const first = await readCalendar({ detail: 'busy', horizonDays: 30, cache, load, now: START });
		const second = await readCalendar({
			detail: 'busy',
			horizonDays: 30,
			cache,
			load,
			now: START + (CALENDAR_FRESH_SECONDS - 1) * 1000
		});

		expect(load).toHaveBeenCalledTimes(1);
		expect(first.status).toBe('fresh');
		expect(second).toMatchObject({ status: 'fresh', ageSeconds: CALENDAR_FRESH_SECONDS - 1 });
	});

	it('reads live again once the payload is 300 s old', async () => {
		const cache = memoryCache(() => START);
		const load = vi.fn(async () => payload('busy', 30, START));

		await readCalendar({ detail: 'busy', horizonDays: 30, cache, load, now: START });
		await readCalendar({
			detail: 'busy',
			horizonDays: 30,
			cache,
			load,
			now: START + CALENDAR_FRESH_SECONDS * 1000
		});

		expect(load).toHaveBeenCalledTimes(2);
	});

	/** The second half of the done-condition: Google is down, the page still renders. */
	it('serves the last good payload when the upstream read fails', async () => {
		const cache = memoryCache(() => START);
		await readCalendar({
			detail: 'titles',
			horizonDays: 90,
			cache,
			load: async () => payload('titles', 90, START),
			now: START
		});

		const view = await readCalendar({
			detail: 'titles',
			horizonDays: 90,
			cache,
			load: async () => {
				throw new Error('calendar: the events endpoint answered 503.');
			},
			now: START + 30 * 60 * 1000
		});

		expect(view.status).toBe('stale');
		expect(view).toMatchObject({ ageSeconds: 1800 });
		expect(view.status === 'stale' && view.payload.blocks[0].title).toBe('Sprint review');
	});

	it('stops serving stale after six hours and says the calendar is unavailable', async () => {
		const cache = memoryCache(() => START);
		await readCalendar({
			detail: 'titles',
			horizonDays: 90,
			cache,
			load: async () => payload('titles', 90, START),
			now: START
		});

		const view = await readCalendar({
			detail: 'titles',
			horizonDays: 90,
			cache,
			load: async () => {
				throw new Error('down');
			},
			now: START + (CALENDAR_MAX_STALE_SECONDS + 1) * 1000
		});

		expect(view).toEqual({ status: 'unavailable' });
	});

	it('reports unavailable when the read fails with nothing cached', async () => {
		const view = await readCalendar({
			detail: 'full',
			horizonDays: 365,
			cache: memoryCache(() => START),
			load: async () => {
				throw new Error('calendar: no usable service-account credential.');
			},
			now: START
		});

		expect(view).toEqual({ status: 'unavailable' });
	});

	/**
	 * The entry is written with a six-hour max-age, not a five-minute one, so
	 * that the stale path has something left to serve. Getting this backwards
	 * would make serve-stale silently dead: it would pass every freshness test
	 * and fail only during an outage.
	 */
	it('keeps the entry in the cache for the whole stale window, not just 300 s', async () => {
		let clock = START;
		const cache = memoryCache(() => clock);
		await readCalendar({
			detail: 'busy',
			horizonDays: 30,
			cache,
			load: async () => payload('busy', 30, START),
			now: START
		});

		clock = START + 5 * 60 * 60 * 1000;
		const view = await readCalendar({
			detail: 'busy',
			horizonDays: 30,
			cache,
			load: async () => {
				throw new Error('down');
			},
			now: clock
		});

		expect(view.status).toBe('stale');
	});

	/**
	 * Default deny applied to the cache itself. A stored payload whose own
	 * `detail` disagrees with the key it was found under is not a payload this
	 * viewer's tier asked for, and the only safe reading is a miss.
	 */
	it('discards a cached payload whose detail or horizon does not match the key', async () => {
		const cache = memoryCache(() => START);
		await cache.put(
			new Request(calendarCacheKey('busy', 30)),
			new Response(JSON.stringify(payload('full', 30, START, 'Interview at Northwind')), {
				headers: { 'cache-control': `max-age=${CALENDAR_MAX_STALE_SECONDS}` }
			})
		);

		const load = vi.fn(async () => payload('busy', 30, START));
		const view = await readCalendar({ detail: 'busy', horizonDays: 30, cache, load, now: START });

		expect(load).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(view)).not.toContain('Interview at Northwind');
	});

	/**
	 * The same rule the redactor enforces on the way in, enforced again on the
	 * way out. An entry written under the `busy` key that somehow carries a
	 * title is not a `busy` payload, whatever it says it is.
	 */
	it('discards a cached payload carrying more than its own detail level allows', async () => {
		const cache = memoryCache(() => START);
		const smuggled = payload('busy', 30, START);
		smuggled.blocks[0].title = 'Dentist — root canal';

		await cache.put(
			new Request(calendarCacheKey('busy', 30)),
			new Response(JSON.stringify(smuggled), {
				headers: { 'cache-control': `max-age=${CALENDAR_MAX_STALE_SECONDS}` }
			})
		);

		const view = await readCalendar({
			detail: 'busy',
			horizonDays: 30,
			cache,
			load: async () => payload('busy', 30, START),
			now: START
		});

		expect(JSON.stringify(view)).not.toContain('Dentist');
	});

	it('treats an unreadable cache entry as a miss rather than as an error', async () => {
		const cache = memoryCache(() => START);
		await cache.put(
			new Request(calendarCacheKey('busy', 30)),
			new Response('not json at all', { headers: { 'cache-control': 'max-age=600' } })
		);

		const view = await readCalendar({
			detail: 'busy',
			horizonDays: 30,
			cache,
			load: async () => payload('busy', 30, START),
			now: START
		});

		expect(view.status).toBe('fresh');
	});

	it('reads live every time when there is no Cache API, as under vite dev', async () => {
		const load = vi.fn(async () => payload('busy', 30, START));

		await readCalendar({ detail: 'busy', horizonDays: 30, cache: null, load, now: START });
		await readCalendar({ detail: 'busy', horizonDays: 30, cache: null, load, now: START });

		expect(load).toHaveBeenCalledTimes(2);
	});
});
