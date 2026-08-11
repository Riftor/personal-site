import { describe, expect, it } from 'vitest';
import { DEFAULT_REDIRECT, safeRedirectTarget } from './redirect-target';

describe('safeRedirectTarget', () => {
	it('keeps a same-origin path, query and fragment intact', () => {
		expect(safeRedirectTarget('/work')).toBe('/work');
		expect(safeRedirectTarget('/work?sort=recent#top')).toBe('/work?sort=recent#top');
	});

	it('falls back to the home page when there is nothing to go back to', () => {
		expect(safeRedirectTarget(null)).toBe(DEFAULT_REDIRECT);
		expect(safeRedirectTarget(undefined)).toBe(DEFAULT_REDIRECT);
		expect(safeRedirectTarget('')).toBe(DEFAULT_REDIRECT);
	});

	// The whole point of the function: a `next` that leaves the site would send
	// someone straight from Google's password prompt to somebody else's page.
	it.each([
		['an absolute URL', 'https://evil.example/phish'],
		['a protocol-relative URL', '//evil.example/phish'],
		['a backslash-smuggled host', '/\\evil.example'],
		['a bare scheme', 'javascript:alert(1)'],
		['a relative path with no leading slash', 'work'],
		['a tab-smuggled host', '/\t/evil.example'],
		['a newline-smuggled host', '/\n/evil.example']
	])('refuses %s', (_label, next) => {
		expect(safeRedirectTarget(next)).toBe(DEFAULT_REDIRECT);
	});
});
