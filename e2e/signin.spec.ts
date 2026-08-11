import { expect, test } from '@playwright/test';

/**
 * What M2 can honestly assert without Google.
 *
 * A real OAuth round trip needs a real Google account and a real consent
 * screen, so **nothing in this file proves that signing in works.** That is a
 * manual check with a second Google account, written up in the M2 notes. What
 * these cases do cover is the half that is entirely ours: the sign-in page
 * renders to a stranger, the request we hand Google is shaped correctly, and a
 * callback that did not come from a genuine flow produces no session.
 */

const SESSION_COOKIE = 'better-auth.session_token';

test('/signin renders to a signed-out stranger, with no redirect', async ({
	page,
	context,
	baseURL
}) => {
	const response = await page.goto('/signin');

	expect(response?.status()).toBe(200);
	expect(page.url()).toBe(new URL('/signin', baseURL).toString());
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Continue with Google');
	await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();

	// Rendering the page must not hand out a session.
	const cookies = await context.cookies();
	expect(cookies.map((cookie) => cookie.name)).not.toContain(SESSION_COOKIE);
});

test('/signin says plainly that signing in grants nothing', async ({ page }) => {
	await page.goto('/signin');

	await expect(page.getByText('does not unlock anything')).toBeVisible();
});

test('the masthead offers sign-in on a public page and names nobody', async ({ page }) => {
	await page.goto('/');

	const masthead = page.getByRole('banner');
	await expect(masthead.getByRole('link', { name: 'Sign in' })).toBeVisible();
	await expect(masthead.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
	await expect(masthead).not.toContainText('@');
});

test('starting sign-in asks Google for identity only, at the registered callback', async ({
	request,
	baseURL
}) => {
	const response = await request.post('/signin/google?next=%2Fwork', { maxRedirects: 0 });

	expect(response.status()).toBe(303);

	const location = new URL(response.headers()['location']);
	expect(location.origin).toBe('https://accounts.google.com');

	// Non-sensitive scopes only. A calendar scope here would trigger Google's
	// verification review and be conceptually wrong — visitors prove identity,
	// they grant Caden nothing.
	expect(location.searchParams.get('scope')?.split(' ').sort()).toEqual([
		'email',
		'openid',
		'profile'
	]);

	// This path is registered in Google's console and cannot differ.
	expect(location.searchParams.get('redirect_uri')).toBe(
		new URL('/api/auth/callback/google', baseURL).toString()
	);
	expect(location.searchParams.get('state')).toBeTruthy();
});

// A callback that did not come from a genuine flow has no matching state, so
// it must be refused before any user or session row is written. These are the
// URLs a stranger can type.
for (const [label, query] of [
	['no parameters at all', ''],
	['a made-up code and state', '?code=made-up&state=made-up'],
	['a code but no state', '?code=made-up']
] as const) {
	test(`the Google callback with ${label} creates no session`, async ({ page, context }) => {
		await page.goto(`/api/auth/callback/google${query}`);

		const cookies = await context.cookies();
		expect(cookies.map((cookie) => cookie.name)).not.toContain(SESSION_COOKIE);

		// The visitor is put back on the sign-in page rather than on Better
		// Auth's unstyled error page.
		expect(new URL(page.url()).pathname).toBe('/signin');
		await expect(page.getByRole('alert')).toBeVisible();

		// And the site still treats them as a stranger.
		await page.goto('/');
		await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
	});
}

test('signing out with no session is a no-op that lands you on a public page', async ({
	request
}) => {
	const response = await request.post('/signout', { maxRedirects: 0 });

	expect(response.status()).toBe(303);
	expect(response.headers()['location']).toBe('/');
});
