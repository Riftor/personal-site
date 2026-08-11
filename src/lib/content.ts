/** Helpers for rendering `content_entry` rows. Safe on both sides of the wire. */

const MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
	month: 'long',
	year: 'numeric',
	timeZone: 'UTC'
});

/**
 * Renders `content_entry.occurred_on` (an ISO `YYYY-MM-DD` date) as e.g.
 * `May 2026`. Fixed to UTC so a viewer west of Greenwich does not see the
 * previous month. Returns null for a missing or unparseable value rather than
 * putting `Invalid Date` on the page.
 */
export function formatOccurredOn(occurredOn: string | null | undefined): string | null {
	if (!occurredOn) return null;

	const parsed = new Date(`${occurredOn}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return null;

	return MONTH_YEAR.format(parsed);
}
