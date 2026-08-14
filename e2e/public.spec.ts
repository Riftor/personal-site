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

/**
 * These assert the *shape* of each page, never its words. The copy lives in D1
 * and is rewritten by `pnpm run publish` without a deploy, so a test that
 * pinned the headline would fail every time Caden edited a sentence — and the
 * failure would say nothing about whether the page still works.
 */
const PUBLIC_PAGES = [{ path: '/' }, { path: '/about' }, { path: '/work' }];

for (const { path } of PUBLIC_PAGES) {
	test(`${path} is readable signed out, with no redirect`, async ({ page, baseURL }) => {
		const response = await page.goto(path);

		expect(response?.status()).toBe(200);
		expect(page.url()).toBe(new URL(path, baseURL).toString());
		await expect(page.locator('h1')).not.toBeEmpty();
	});
}

/**
 * The seed rows in `drizzle/0001_content_entry.sql` mark every string
 * `[PLACEHOLDER]` so that unwritten copy cannot be mistaken for real
 * biography. This is the check that the site is not still serving them.
 */
for (const { path } of PUBLIC_PAGES) {
	test(`${path} serves no placeholder copy`, async ({ page }) => {
		await page.goto(path);

		await expect(page.locator('body')).not.toContainText('[PLACEHOLDER]');
	});
}

test('the home page previews projects and links to the rest', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'Selected work' })).toBeVisible();
	// At least one, and never more than the FEATURED_COUNT the loader asks for.
	const featured = page.getByRole('heading', { level: 3 });
	expect(await featured.count()).toBeGreaterThan(0);
	expect(await featured.count()).toBeLessThanOrEqual(3);
	await expect(page.getByRole('link', { name: 'All work' })).toBeVisible();
});

test('/work lists every published project, with its body', async ({ page }) => {
	await page.goto('/work');

	expect(await page.getByRole('heading', { level: 3 }).count()).toBeGreaterThan(0);
	// The body is the point of this page — a project rendered as a bare card
	// with its prose dropped would still pass a count-only assertion.
	await expect(page.locator('.entry .prose p').first()).not.toBeEmpty();
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
