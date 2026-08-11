import { expect, test } from '@playwright/test';

/**
 * Done-condition #1: the portfolio half is readable by a stranger.
 *
 * Every case runs in a fresh browser context (Playwright's default per test)
 * so there is no cookie and no session. The assertions that matter are the
 * status code and the *final* URL — a page that 302s to `/signin` and then
 * renders a 200 would pass a naive content check, so the redirect is checked
 * explicitly rather than inferred.
 */

const PUBLIC_PAGES = [
	{ path: '/', heading: 'One line that says what you do' },
	{ path: '/about', heading: 'About' },
	{ path: '/work', heading: 'Work' }
];

for (const { path, heading } of PUBLIC_PAGES) {
	test(`${path} is readable signed out, with no redirect`, async ({ page, baseURL }) => {
		const response = await page.goto(path);

		expect(response?.status()).toBe(200);
		expect(page.url()).toBe(new URL(path, baseURL).toString());
		await expect(page.locator('h1')).toContainText(heading);
	});
}

test('the home page renders seeded projects and links to the rest', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'Selected work' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3 })).toHaveCount(3);
	await expect(page.getByRole('link', { name: 'All work' })).toBeVisible();
});

test('/work lists every seeded project', async ({ page }) => {
	await page.goto('/work');

	await expect(page.getByRole('heading', { level: 3 })).toHaveCount(4);
});

test('/about renders the prose body from D1', async ({ page }) => {
	await page.goto('/about');

	await expect(page.locator('.prose p').first()).not.toBeEmpty();
	await expect(page.getByRole('heading', { name: /How I work/ })).toBeVisible();
});

test('no horizontal scroll on a 360px viewport', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 780 });

	for (const { path } of PUBLIC_PAGES) {
		await page.goto(path);
		const overflows = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth
		);
		expect(overflows, `${path} scrolls horizontally at 360px`).toBe(false);
	}
});
