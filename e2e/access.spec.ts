import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';

/**
 * Done-conditions #2 and #4: a stranger poking at private URLs gets a redirect
 * or a 403 — never content — and two accounts at different tiers demonstrably
 * see different sites.
 *
 * Three things about how this is written are deliberate:
 *
 *  - **Direct URL navigation only.** Nothing here clicks a link. The threat is
 *    a private URL pasted into a chat, typed from memory, or guessed, so every
 *    request is made against the URL itself with no page state in front of it.
 *  - **Exact status codes, with redirects unfollowed.** `302 -> /signin` and
 *    `403` are different answers to different questions (plan §2) and
 *    collapsing them would hide a real regression. Following redirects would
 *    turn a 302 into the sign-in page's 200.
 *  - **Assertions against the raw response body,** not the rendered DOM. A
 *    page's data is serialised into the HTML payload as well as rendered into
 *    it, so a component that "hides" content the loader returned would still
 *    fail these checks. That is the point: the loader must refuse before it
 *    returns anything.
 *
 * Sessions come from `scripts/seed-e2e-access.mjs`, which writes rows into the
 * same D1 tables Google's callback would. No live Google, and no test-only
 * code path in `src/`.
 */

type Fixture = { email: string; tier: string | null; revoked: boolean; cookie: string };

const { cookieName, fixtures } = JSON.parse(
	readFileSync(new URL('./.access-fixtures.json', import.meta.url), 'utf8')
) as { cookieName: string; fixtures: Record<string, Fixture> };

/**
 * The three private pages, with the strings their loaders return. Every one of
 * these must appear on a 200 and must appear nowhere in a refusal.
 */
const PRIVATE_PAGES = [
	{
		path: '/private/now',
		minRank: 10,
		sentinels: ['Learning to solder without burning the bench', 'Reading the same three books']
	},
	{
		path: '/private/photos',
		minRank: 20,
		sentinels: ['Cornwall, July 2026', 'Family dinner, June 2026']
	},
	{
		// The memory index (M6). Its own entries carry per-entry tiers on top of
		// this floor; `content.spec.ts` covers that.
		path: '/private/memories',
		minRank: 20,
		sentinels: ['Trips, days out', 'Three days of rain']
	},
	{
		// Reachable from `friend`; how much of it each tier sees is
		// `tier.calendar_detail`'s decision, covered in `calendar.spec.ts`.
		// The sentinels are the page's own frame rather than event content:
		// this page renders Caden's real calendar, so nothing about the events
		// is stable enough to assert, and none of it belongs in a test file.
		path: '/private/calendar',
		minRank: 10,
		sentinels: ['Showing the next', 'Home timezone']
	}
] as const;

/** The four viewers of the matrix. `null` is a browser with no cookie at all. */
const VIEWERS = [
	{ label: 'signed out', fixture: null, rank: 0 },
	{ label: 'friend', fixture: 'friend', rank: 10 },
	{ label: 'family', fixture: 'family', rank: 20 },
	{ label: 'partner', fixture: 'partner', rank: 30 }
] as const;

async function signIn(context: BrowserContext, key: string, baseURL: string) {
	const fixture = fixtures[key];
	expect(fixture, `fixture "${key}" was not seeded`).toBeTruthy();

	await context.addCookies([{ name: cookieName, value: fixture.cookie, url: baseURL }]);
	return fixture;
}

const signinLocationFor = (path: string) => `/signin?next=${encodeURIComponent(path)}`;

/* ------------------------------------------------------------------ *
 * The matrix: 4 viewers x 4 private URLs = 16 cases.
 * ------------------------------------------------------------------ */

for (const viewer of VIEWERS) {
	for (const page of PRIVATE_PAGES) {
		const allowed = viewer.rank >= page.minRank;
		const expected = !viewer.fixture ? '302 to /signin' : allowed ? '200' : '403';

		test(`${viewer.label} on ${page.path} -> ${expected}`, async ({ context, baseURL }) => {
			const fixture = viewer.fixture ? await signIn(context, viewer.fixture, baseURL!) : null;

			const response = await context.request.get(page.path, { maxRedirects: 0 });
			const body = await response.text();

			if (!fixture) {
				// A stranger is sent to sign in, and the answer is the same
				// whether the page exists or not, so probing enumerates nothing.
				expect(response.status()).toBe(302);
				expect(response.headers()['location']).toBe(signinLocationFor(page.path));
			} else if (allowed) {
				expect(response.status()).toBe(200);
				for (const sentinel of page.sentinels) {
					expect(body, `${page.path} should render its content for ${viewer.label}`).toContain(
						sentinel
					);
				}
			} else {
				expect(response.status()).toBe(403);
				expect(body).toContain('No access.');
				// The page names the account, so being signed into the wrong
				// Google account is self-diagnosable.
				expect(body).toContain(fixture.email);
			}

			// The load-bearing half: on anything that is not a 200, none of the
			// page's real content may appear anywhere in the response — not
			// rendered, not in the serialised data payload, not in a comment.
			if (!allowed) {
				for (const sentinel of page.sentinels) {
					expect(body, `${page.path} leaked "${sentinel}" to ${viewer.label}`).not.toContain(
						sentinel
					);
				}
			}
		});
	}
}

/* ------------------------------------------------------------------ *
 * The edges the matrix does not reach.
 * ------------------------------------------------------------------ */

test('the signed-out redirect round-trips the query string too', async ({ context }) => {
	const response = await context.request.get('/private/photos?set=cornwall', { maxRedirects: 0 });

	expect(response.status()).toBe(302);
	expect(response.headers()['location']).toBe(signinLocationFor('/private/photos?set=cornwall'));
});

test('an unlisted /private path default-denies even the highest granted tier', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'partner', baseURL!);

	// Rank 30 is the highest tier Caden grants anyone, and it still must not
	// clear a path nobody listed: the route table defaults those to owner-only,
	// so a page added without an entry fails closed.
	const response = await context.request.get('/private/secrets', { maxRedirects: 0 });

	expect(response.status()).toBe(403);
});

test('a refused visitor cannot tell an existing private page from an invented one', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'friend', baseURL!);

	// `/private/photos` exists and needs `family`; `/private/secrets` does not
	// exist at all. Both refuse this session, and the two refusals must be
	// indistinguishable or the difference enumerates the private half.
	const real = await context.request.get('/private/photos', { maxRedirects: 0 });
	const invented = await context.request.get('/private/secrets', { maxRedirects: 0 });

	expect(real.status()).toBe(403);
	expect(invented.status()).toBe(403);
	expect(await invented.text()).toBe(await real.text());
});

test('an unlisted /private path redirects a stranger like any other', async ({ context }) => {
	const response = await context.request.get('/private/secrets', { maxRedirects: 0 });

	expect(response.status()).toBe(302);
	expect(response.headers()['location']).toBe(signinLocationFor('/private/secrets'));
});

test('a signed-in visitor with no grant at all is refused, not treated as pending', async ({
	context,
	baseURL
}) => {
	const fixture = await signIn(context, 'nogrant', baseURL!);

	for (const page of PRIVATE_PAGES) {
		const response = await context.request.get(page.path, { maxRedirects: 0 });

		expect(response.status(), page.path).toBe(403);
		expect(await response.text()).toContain(fixture.email);
	}
});

test('a grant naming a tier with no calendar is refused, not shown an empty week', async ({
	context,
	baseURL
}) => {
	// `public` is a real tier with a live grant behind it; its
	// `calendar_detail` is `none`. An empty agenda would read as "he is free",
	// so the page refuses — and refuses identically to a page that does not
	// exist, so this tells the visitor nothing about the private half.
	const fixture = await signIn(context, 'publictier', baseURL!);
	expect(fixture.tier).toBe('public');

	const real = await context.request.get('/private/calendar', { maxRedirects: 0 });
	const invented = await context.request.get('/private/secrets', { maxRedirects: 0 });
	const body = await real.text();

	expect(real.status()).toBe(403);
	expect(body).toContain(fixture.email);
	expect(body).not.toContain('Showing the next');
	expect(body).not.toContain('Home timezone');
	expect(body).toBe(await invented.text());
});

test('a soft-revoked grant grants nothing', async ({ context, baseURL }) => {
	// `access_grant` row still exists at tier `family`; only `revoked_at` is
	// set. Reading the table without the `revoked_at IS NULL` filter would let
	// this session straight into /private/photos.
	const fixture = await signIn(context, 'revoked', baseURL!);
	expect(fixture.tier).toBe('family');
	expect(fixture.revoked).toBe(true);

	const response = await context.request.get('/private/photos', { maxRedirects: 0 });

	expect(response.status()).toBe(403);
	expect(await response.text()).not.toContain('Cornwall, July 2026');
});

test('private responses are marked uncacheable and varying by cookie', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'partner', baseURL!);
	const response = await context.request.get('/private/calendar', { maxRedirects: 0 });

	expect(response.status()).toBe(200);
	expect(response.headers()['cache-control']).toBe('private, no-store');
	expect(response.headers()['vary']).toContain('Cookie');
});

test('the 403 page renders the account and an escape route, and no page content', async ({
	page,
	context,
	baseURL
}) => {
	const fixture = await signIn(context, 'friend', baseURL!);

	const response = await page.goto('/private/photos');

	expect(response?.status()).toBe(403);
	// It must not bounce an authenticated visitor into a sign-in loop.
	expect(new URL(page.url()).pathname).toBe('/private/photos');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('No access.');
	await expect(page.getByText(fixture.email, { exact: false }).first()).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Sign out and try another account' })
	).toBeVisible();
	await expect(page.locator('body')).not.toContainText('Cornwall, July 2026');
});

test('a granted account still reads the public site, and sees only its own tier in the nav', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'friend', baseURL!);
	await page.goto('/');

	expect(page.url()).toBe(new URL('/', baseURL).toString());

	const nav = page.getByRole('navigation', { name: 'Primary' });
	await expect(nav.getByRole('link', { name: 'Now' })).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Calendar' })).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Photos' })).toHaveCount(0);
});
