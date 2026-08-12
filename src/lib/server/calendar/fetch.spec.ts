import { describe, expect, it, vi } from 'vitest';
import { memoryCache } from '../testing/memory-cache';
import { fetchCalendarEvents, horizonWindow, loadCalendarPayload } from './fetch';
import type { GoogleCalendarEvent } from './redact';

/**
 * Pagination and the per-band window (plan §4).
 *
 * The pagination case is the one worth writing carefully: Google truncates by
 * handing back a `nextPageToken`, not by erroring, so a single-page fetch
 * produces a calendar that renders perfectly and is missing its far end. A
 * test that only ever feeds one page cannot tell the two implementations
 * apart, so every fixture here is multi-page.
 */

const NOW = Date.parse('2026-08-12T09:00:00Z');
const CALENDAR_ID = 'caden@gmail.com';

const event = (summary: string): GoogleCalendarEvent => ({
	summary,
	start: { dateTime: '2026-08-12T14:00:00Z' },
	end: { dateTime: '2026-08-12T15:00:00Z' }
});

/** A calendar that answers with `pages` pages and records every request made. */
function paginatedCalendar(pages: GoogleCalendarEvent[][], timeZone = 'Europe/London') {
	const urls: URL[] = [];
	const headers: Headers[] = [];

	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		urls.push(url);
		headers.push(new Headers(init?.headers));

		const index = url.searchParams.has('pageToken')
			? Number(url.searchParams.get('pageToken')!.replace('page-', ''))
			: 0;
		const isLast = index >= pages.length - 1;

		return new Response(
			JSON.stringify({
				timeZone,
				items: pages[index] ?? [],
				...(isLast ? {} : { nextPageToken: `page-${index + 1}` })
			}),
			{ headers: { 'content-type': 'application/json' } }
		);
	});

	return { fetchImpl, urls, headers };
}

describe('horizonWindow', () => {
	it('looks one day back and `horizonDays` forward', () => {
		const { timeMin, timeMax } = horizonWindow(30, NOW);

		expect(timeMin.toISOString()).toBe('2026-08-11T09:00:00.000Z');
		expect(timeMax.toISOString()).toBe('2026-09-11T09:00:00.000Z');
	});

	it('refuses a horizon that is not a positive whole number of days', () => {
		expect(() => horizonWindow(0, NOW)).toThrow(/usable horizon/);
		expect(() => horizonWindow(-30, NOW)).toThrow(/usable horizon/);
		expect(() => horizonWindow(30.5, NOW)).toThrow(/usable horizon/);
		expect(() => horizonWindow(NaN, NOW)).toThrow(/usable horizon/);
	});
});

describe('fetchCalendarEvents', () => {
	it('follows nextPageToken to the end rather than truncating at 250', async () => {
		const pages = [
			Array.from({ length: 250 }, (_, index) => event(`first-${index}`)),
			Array.from({ length: 250 }, (_, index) => event(`second-${index}`)),
			[event('last')]
		];
		const { fetchImpl, urls } = paginatedCalendar(pages);

		const result = await fetchCalendarEvents({
			calendarId: CALENDAR_ID,
			accessToken: 'token',
			horizonDays: 365,
			now: NOW,
			fetch: fetchImpl
		});

		expect(result.events).toHaveLength(501);
		expect(result.truncated).toBe(false);
		expect(urls.map((url) => url.searchParams.get('pageToken'))).toEqual([
			null,
			'page-1',
			'page-2'
		]);
	});

	it('sends the parameters plan §4 specifies, on every page', async () => {
		const { fetchImpl, urls, headers } = paginatedCalendar([[event('a')], [event('b')]]);

		await fetchCalendarEvents({
			calendarId: CALENDAR_ID,
			accessToken: 'token',
			horizonDays: 90,
			now: NOW,
			fetch: fetchImpl
		});

		for (const url of urls) {
			expect(url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`);
			expect(url.searchParams.get('singleEvents')).toBe('true');
			expect(url.searchParams.get('orderBy')).toBe('startTime');
			expect(url.searchParams.get('maxResults')).toBe('250');
			expect(url.searchParams.get('showDeleted')).toBe('false');
			expect(url.searchParams.get('timeMin')).toBe('2026-08-11T09:00:00.000Z');
			expect(url.searchParams.get('timeMax')).toBe('2026-11-10T09:00:00.000Z');
		}

		expect(headers.map((header) => header.get('authorization'))).toEqual([
			'Bearer token',
			'Bearer token'
		]);
	});

	/** Each band fetches its own window; nobody slices a year in memory. */
	it('asks for only its own horizon, band by band', async () => {
		for (const [horizonDays, timeMax] of [
			[30, '2026-09-11T09:00:00.000Z'],
			[90, '2026-11-10T09:00:00.000Z'],
			[365, '2027-08-12T09:00:00.000Z']
		] as const) {
			const { fetchImpl, urls } = paginatedCalendar([[]]);
			await fetchCalendarEvents({
				calendarId: CALENDAR_ID,
				accessToken: 'token',
				horizonDays,
				now: NOW,
				fetch: fetchImpl
			});

			expect(urls[0].searchParams.get('timeMax')).toBe(timeMax);
		}
	});

	it('stops at the ten-page cap and says so rather than looping', async () => {
		const { fetchImpl } = paginatedCalendar(Array.from({ length: 20 }, () => [event('x')]));

		const result = await fetchCalendarEvents({
			calendarId: CALENDAR_ID,
			accessToken: 'token',
			horizonDays: 365,
			now: NOW,
			fetch: fetchImpl
		});

		expect(fetchImpl).toHaveBeenCalledTimes(10);
		expect(result.truncated).toBe(true);
	});

	/**
	 * The 404 the API returns today, before Caden has shared his calendar with
	 * the service account. It must surface as a failure — the caller turns it
	 * into serve-stale — and never as an empty calendar.
	 */
	it('throws on the 404 an unshared calendar returns', async () => {
		const fetchImpl = vi.fn(async () => new Response('Not Found', { status: 404 }));

		await expect(
			fetchCalendarEvents({
				calendarId: CALENDAR_ID,
				accessToken: 'token',
				horizonDays: 30,
				now: NOW,
				fetch: fetchImpl
			})
		).rejects.toThrow('calendar: the events endpoint answered 404.');
	});

	it('throws on a 200 whose body is not a usable event list', async () => {
		for (const body of ['<html>nope</html>', JSON.stringify({ kind: 'calendar#events' })]) {
			const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));

			await expect(
				fetchCalendarEvents({
					calendarId: CALENDAR_ID,
					accessToken: 'token',
					horizonDays: 30,
					now: NOW,
					fetch: fetchImpl
				})
			).rejects.toThrow(/calendar: the events endpoint|carried no items array/);
		}
	});
});

describe('loadCalendarPayload', () => {
	const credentialsFor = async () => {
		const pair = (await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256'
			},
			true,
			['sign', 'verify']
		)) as CryptoKeyPair;

		const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
		return {
			clientEmail: 'reader@personal-site.iam.gserviceaccount.com',
			privateKeyPem: [
				'-----BEGIN PRIVATE KEY-----',
				...(btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g) ?? []),
				'-----END PRIVATE KEY-----',
				''
			].join('\\n')
		};
	};

	it('mints a token, paginates, and hands the result to the redactor', async () => {
		const credentials = await credentialsFor();
		const calendar = paginatedCalendar([[event('Sprint review')], [event('Retro')]]);

		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
				return new Response(JSON.stringify({ access_token: 'ya29.test' }), {
					headers: { 'content-type': 'application/json' }
				});
			}
			return calendar.fetchImpl(input, init);
		});

		const payload = await loadCalendarPayload({
			credentials,
			calendarId: CALENDAR_ID,
			detail: 'busy',
			horizonDays: 30,
			now: NOW,
			fetch: fetchImpl,
			tokenCache: memoryCache()
		});

		expect(payload).toMatchObject({ detail: 'busy', horizonDays: 30, timeZone: 'Europe/London' });
		expect(payload.blocks).toHaveLength(1); // both events sit in the same hour
		expect(JSON.stringify(payload)).not.toContain('Sprint review');
	});
});
