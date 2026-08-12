import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';

/**
 * Done-condition #5, and the M5.5 done-condition specifically: partner and
 * friend sessions visibly differ in detail and in horizon.
 *
 * This suite runs against **Caden's real calendar**, through the real service
 * account, so nothing here asserts anything about an event. Not a title, not a
 * time, not a count — those are his private data and they change hourly. What
 * is asserted is the frame the tier decides: how far ahead the page says it is
 * showing, what it says this tier may see, and whether the markup that carries
 * a title or a location is present at all. That is exactly the seam under
 * test, and it is stable whether Google answers or not.
 *
 * The tier → detail/horizon mapping itself is unit-tested exhaustively in
 * `src/lib/server/calendar/access.spec.ts`; this proves the wiring reaches a
 * browser.
 */

type Fixture = { email: string; tier: string | null; revoked: boolean; cookie: string };

const { cookieName, fixtures } = JSON.parse(
	readFileSync(new URL('./.access-fixtures.json', import.meta.url), 'utf8')
) as { cookieName: string; fixtures: Record<string, Fixture> };

/** The seeded `tier` rows, as plan §3 marks them AUTHORITATIVE. */
const TIERS = [
	{
		key: 'friend',
		horizonDays: 30,
		caption: 'Busy blocks only. No titles, locations, or descriptions at your tier.'
	},
	{
		key: 'family',
		horizonDays: 90,
		caption: 'Event titles. No locations or descriptions at your tier.'
	},
	{ key: 'partner', horizonDays: 365, caption: 'Titles, locations, and descriptions.' }
] as const;

async function signIn(context: BrowserContext, key: string, baseURL: string) {
	const fixture = fixtures[key];
	expect(fixture, `fixture "${key}" was not seeded`).toBeTruthy();

	await context.addCookies([{ name: cookieName, value: fixture.cookie, url: baseURL }]);
	return fixture;
}

async function calendarFor(context: BrowserContext, key: string, baseURL: string) {
	await signIn(context, key, baseURL);
	const response = await context.request.get('/private/calendar', { maxRedirects: 0 });

	expect(response.status(), `${key} should be able to open the calendar`).toBe(200);
	return response.text();
}

for (const { key, horizonDays, caption } of TIERS) {
	test(`${key} gets the ${horizonDays}-day horizon its tier row specifies`, async ({
		context,
		baseURL
	}) => {
		const body = await calendarFor(context, key, baseURL!);

		expect(body).toContain(`Showing the next ${horizonDays} days`);
		expect(body).toContain(caption);

		// And not any other tier's, so a mis-wired seam cannot pass by
		// rendering everything.
		for (const other of TIERS) {
			if (other.horizonDays === horizonDays) continue;
			expect(body, `${key} showed the ${other.horizonDays}-day horizon`).not.toContain(
				`Showing the next ${other.horizonDays} days`
			);
			expect(body, `${key} showed the ${other.key} caption`).not.toContain(other.caption);
		}
	});
}

test('the friend view carries no title, location, or description markup at all', async ({
	context,
	baseURL
}) => {
	const body = await calendarFor(context, 'friend', baseURL!);

	// `redact.ts` never puts them in the payload and the page has no way to
	// invent them, so the elements that would hold them are simply absent.
	// Asserting on the markup rather than on content means this holds on a day
	// when the 30-day window happens to be empty.
	expect(body).not.toContain('entry__title');
	expect(body).not.toContain('entry__meta');
	expect(body).toContain('Busy blocks only.');
});

test('a longer horizon is a superset, never a shorter one', async ({ browser, baseURL }) => {
	const count = async (key: string) => {
		const context = await browser.newContext({ baseURL });
		try {
			const body = await calendarFor(context, key, baseURL!);
			return body.split('class="entry ').length - 1;
		} finally {
			await context.close();
		}
	};

	const [friend, partner] = [await count('friend'), await count('partner')];

	// 30 days of a calendar cannot contain more than 365 days of the same one.
	// Both are zero if Google is unreachable, which this does not treat as a
	// failure — the staleness and unavailable states are the page's answer to
	// that, and they are covered in the component suite.
	expect(partner).toBeGreaterThanOrEqual(friend);
});

test('a visitor in another timezone is shown both readings', async ({ browser, baseURL }) => {
	// Caden's calendar is not in Tokyo, so this viewer's clock disagrees with
	// his by a whole working day — the case plan §4 calls "the difference
	// between a useful calendar and a missed dinner".
	const context = await browser.newContext({ baseURL, timezoneId: 'Asia/Tokyo' });

	try {
		await signIn(context, 'partner', baseURL!);
		const page = await context.newPage();
		await page.goto('/private/calendar');

		await expect(page.getByText('Home timezone', { exact: false })).toBeVisible();
		await expect(page.getByText('Asia/Tokyo', { exact: false })).toBeVisible();

		// Every timed entry gets the viewer's own reading beside Caden's. An
		// empty window has none to annotate, which is not a failure.
		const timed = await page.locator('.entry__when time').count();
		if (timed > 0) {
			expect(await page.locator('.entry__local').count()).toBeGreaterThan(0);
		}
	} finally {
		await context.close();
	}
});

test('the calendar page is uncacheable and varies by cookie, like the rest of the private half', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'friend', baseURL!);
	const response = await context.request.get('/private/calendar', { maxRedirects: 0 });

	expect(response.status()).toBe(200);
	expect(response.headers()['cache-control']).toBe('private, no-store');
	expect(response.headers()['vary']).toContain('Cookie');
});
