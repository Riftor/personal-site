import { describe, it, expect } from 'vitest';
import { formatOccurredOn } from './content';

describe('formatOccurredOn', () => {
	it('renders an ISO date as month and year', () => {
		expect(formatOccurredOn('2026-05-01')).toBe('May 2026');
	});

	it('reads the date in UTC, not the viewer timezone', () => {
		// 1 January would fall back into December for any negative-offset viewer
		// if the date were parsed as local time.
		expect(formatOccurredOn('2026-01-01')).toBe('January 2026');
	});

	it('returns null for a missing or unparseable date', () => {
		expect(formatOccurredOn(null)).toBeNull();
		expect(formatOccurredOn(undefined)).toBeNull();
		expect(formatOccurredOn('')).toBeNull();
		expect(formatOccurredOn('not-a-date')).toBeNull();
	});
});
