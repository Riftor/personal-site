import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CalendarPage from './+page.svelte';
import type { PageData } from './$types';

/**
 * The two notices M5.4 computed and nothing rendered.
 *
 * `truncated` and the serve-stale age are the halves of the calendar that say
 * "what you are looking at is not the whole truth". Neither can be provoked
 * from the e2e suite — one needs a calendar with more than 2,500 events in the
 * window, the other needs Google to be down — so they are proved here, at the
 * only layer where the state can simply be handed in.
 *
 * The empty case is in here for the same reason it is in the page at all: an
 * agenda with no rows and no explanation reads as "he is free", and that is
 * the one thing this page must never say by accident.
 */

type Data = PageData;

/** The page's other two props are part of `PageProps` and unused here. */
function mount(data: Data) {
	render(CalendarPage, { data, params: {}, form: null });
}

function data(overrides: Partial<Data> = {}): Data {
	return {
		viewer: { email: 'someone@example.test', tierSlug: 'partner' },
		detail: 'full',
		detailCaption: 'Titles, locations, and descriptions.',
		horizonDays: 365,
		horizonEndsOn: 'Thu 12 Aug 2027',
		timeZone: 'Europe/London',
		status: 'fresh',
		truncated: false,
		updatedAt: '09:14',
		updatedAgo: '3 minutes ago',
		weeks: [
			{
				start: '2026-08-10',
				label: 'Week of Mon 10 Aug',
				days: [
					{
						date: '2026-08-13',
						label: 'Thu 13 Aug',
						entries: [
							{
								key: '0',
								date: '2026-08-13',
								startIso: '2026-08-13T09:00:00+01:00',
								endIso: '2026-08-13T10:30:00+01:00',
								allDay: false,
								startMs: Date.parse('2026-08-13T09:00:00+01:00'),
								endMs: Date.parse('2026-08-13T10:30:00+01:00'),
								startTime: '09:00',
								endTime: '10:30',
								endsOn: null,
								title: 'Sprint review',
								location: 'The Studio',
								description: 'Bring the brief.'
							}
						]
					}
				]
			}
		],
		...overrides
	} as Data;
}

describe('/private/calendar', () => {
	it('renders the horizon, the home timezone, and what this tier may see', async () => {
		mount(data());

		await expect
			.element(page.getByText('Showing the next 365 days, to Thu 12 Aug 2027.', { exact: false }))
			.toBeInTheDocument();
		await expect.element(page.getByText('Home timezone', { exact: false })).toBeInTheDocument();
		await expect
			.element(page.getByText('Titles, locations, and descriptions.'))
			.toBeInTheDocument();
	});

	it('renders an event at full detail, in home time', async () => {
		mount(data());

		await expect.element(page.getByText('Sprint review')).toBeInTheDocument();
		await expect.element(page.getByText('The Studio')).toBeInTheDocument();
		await expect.element(page.getByText('09:00')).toBeInTheDocument();
	});

	it('labels a block with no title as Busy rather than as nothing', async () => {
		const busy = data();
		busy.weeks[0].days[0].entries[0].title = null;
		busy.weeks[0].days[0].entries[0].location = null;
		busy.weeks[0].days[0].entries[0].description = null;

		mount(busy);

		await expect.element(page.getByText('Busy', { exact: true })).toBeInTheDocument();
	});

	/**
	 * The carry-forward from the M5 review. The pagination cap exists so a
	 * missing far end is *known*; it is only actually prevented if the page
	 * says so.
	 */
	it('says so, visibly, when the window is truncated', async () => {
		mount(data({ truncated: true }));

		await expect.element(page.getByText('This view is incomplete.')).toBeInTheDocument();
		await expect.element(page.getByText('unknown, not free', { exact: false })).toBeInTheDocument();
	});

	it('says when it is serving a stale payload, and how old it is', async () => {
		mount(data({ status: 'stale', updatedAt: '07:02', updatedAgo: '2 hours ago' }));

		await expect.element(page.getByText('Not live.')).toBeInTheDocument();
		await expect.element(page.getByText('07:02', { exact: false })).toBeInTheDocument();
		await expect.element(page.getByText('2 hours ago', { exact: false })).toBeInTheDocument();
	});

	it('refuses to imply availability when the calendar cannot be read', async () => {
		mount(data({ status: 'unavailable', updatedAt: null, updatedAgo: null, weeks: [] }));

		await expect.element(page.getByText('Calendar unavailable.')).toBeInTheDocument();
		await expect
			.element(page.getByText('This is not a statement that he is free', { exact: false }))
			.toBeInTheDocument();
	});

	it('says an empty window is empty rather than showing nothing at all', async () => {
		mount(data({ weeks: [] }));

		await expect.element(page.getByText('Nothing in the next 365 days.')).toBeInTheDocument();
	});

	/**
	 * Plan §4: "ambiguity here is the difference between a useful calendar and
	 * a missed dinner". The browser these tests run in is not in London, so
	 * the viewer-local pass must produce a second reading of the same event.
	 */
	it('shows the viewer their own timezone alongside Caden’s', async () => {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const away = zone === 'Asia/Tokyo' ? 'Europe/London' : 'Asia/Tokyo';

		mount(data({ timeZone: away }));

		await expect.element(page.getByText('Your timezone', { exact: false })).toBeInTheDocument();
		await expect.element(page.getByText(zone, { exact: false }).first()).toBeInTheDocument();
	});
});
