<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Derived from the loader rather than imported: `$lib/server` is server-only. */
	type AgendaEntry = (typeof data)['weeks'][number]['days'][number]['entries'][number];

	/**
	 * The viewer's own timezone, resolved in the browser and `null` while it
	 * is unknown or when it matches Caden's.
	 *
	 * The server renders every time in Caden's home zone and labels it, which
	 * is the half that has to be right with no JavaScript at all. This is the
	 * other half of plan §4's "ambiguity here is the difference between a
	 * useful calendar and a missed dinner": a visitor two zones away needs to
	 * see both readings, and the server cannot know theirs.
	 */
	let viewerZone = $state<string | null>(null);

	$effect(() => {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		viewerZone = typeof zone === 'string' && zone !== data.timeZone ? zone : null;
	});

	const localClock = $derived(
		viewerZone
			? new Intl.DateTimeFormat('en-GB', {
					timeZone: viewerZone,
					hour: '2-digit',
					minute: '2-digit',
					hourCycle: 'h23'
				})
			: null
	);

	const localDay = $derived(
		viewerZone
			? new Intl.DateTimeFormat('en-GB', {
					timeZone: viewerZone,
					weekday: 'short',
					day: 'numeric',
					month: 'short'
				})
			: null
	);

	const localDate = $derived(
		viewerZone
			? new Intl.DateTimeFormat('en-CA', {
					timeZone: viewerZone,
					year: 'numeric',
					month: '2-digit',
					day: '2-digit'
				})
			: null
	);

	/**
	 * "04:00–05:30" in the viewer's zone, with the date when the event lands on
	 * a different day for them than it does for Caden. All-day bands carry no
	 * instant and are the same day everywhere, so they get nothing.
	 */
	function localRange(entry: AgendaEntry): string | null {
		if (!localClock || !localDate || entry.startMs === null) return null;

		const start = new Date(entry.startMs);
		const range =
			entry.endMs === null
				? localClock.format(start)
				: `${localClock.format(start)}–${localClock.format(new Date(entry.endMs))}`;

		const shifted = localDate.format(start) !== entry.date;
		return shifted && localDay ? `${localDay.format(start)}, ${range}` : range;
	}
</script>

<svelte:head>
	<title>Calendar — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow">Private · {data.viewer.tierSlug}</p>
		<h1>Calendar</h1>
		<p class="lede__summary">
			Showing the next {data.horizonDays} days, to {data.horizonEndsOn}. {data.detailCaption}
		</p>
		<p class="zones">
			<span>Home timezone <strong>{data.timeZone}</strong>.</span>
			{#if viewerZone}
				<span>Your timezone <strong>{viewerZone}</strong>, shown in brackets.</span>
			{/if}
		</p>
	</header>

	{#if data.status === 'unavailable'}
		<!--
			No payload, and no recent one to fall back on. Saying nothing here
			would render an empty week, which reads as "he is free" — the one
			thing this page must never say by accident.
		-->
		<p class="notice notice--loud" role="status">
			<strong>Calendar unavailable.</strong> Caden's calendar could not be read just now and there is
			no recent copy to fall back on. This is not a statement that he is free — treat the whole window
			as unknown and check with him.
		</p>
	{:else}
		{#if data.status === 'stale'}
			<p class="notice notice--loud" role="status">
				<strong>Not live.</strong> The calendar could not be re-read, so this is how it stood at
				{data.updatedAt} ({data.updatedAgo}). Anything added or moved since is missing.
			</p>
		{/if}

		{#if data.truncated}
			<p class="notice notice--loud" role="status">
				<strong>This view is incomplete.</strong> Caden's calendar returned more events than this
				page reads in one pass, so the far end of the next {data.horizonDays} days is missing. What is
				shown is real; what is absent is unknown, not free.
			</p>
		{/if}

		{#if data.weeks.length === 0}
			<p class="notice">Nothing in the next {data.horizonDays} days.</p>
		{/if}

		{#each data.weeks as week (week.start)}
			<section class="week">
				<h2 class="week__label">{week.label}</h2>

				{#each week.days as day (day.date)}
					<div class="day">
						<h3 class="day__label">{day.label}</h3>

						<ul class="entries" role="list">
							{#each day.entries as entry (entry.key)}
								{@const local = localRange(entry)}
								<li class="entry">
									<p class="entry__when">
										{#if entry.allDay}
											<span>All day</span>
										{:else}
											<time datetime={entry.startIso}>{entry.startTime}</time
											>{#if entry.endTime}–<time datetime={entry.endIso}>{entry.endTime}</time>{/if}
										{/if}
										{#if entry.endsOn}<span class="entry__spans">to {entry.endsOn}</span>{/if}
										{#if local}<span class="entry__local">({local})</span>{/if}
									</p>

									{#if entry.title}
										<p class="entry__title">{entry.title}</p>
									{:else}
										<p class="entry__busy">Busy</p>
									{/if}

									{#if entry.location}
										<p class="entry__meta">{entry.location}</p>
									{/if}
									{#if entry.description}
										<p class="entry__meta entry__meta--wrap">{entry.description}</p>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</section>
		{/each}

		{#if data.status === 'fresh' && data.updatedAt}
			<p class="signature">Read from Google at {data.updatedAt} ({data.updatedAgo}).</p>
		{/if}
	{/if}

	<p class="signature">
		Events Caden marked private show as Busy at every tier, and guest lists are never shown. Signed
		in as {data.viewer.email} ({data.viewer.tierSlug}).
	</p>
</article>

<style>
	.lede {
		max-width: var(--measure);
	}

	.lede__summary {
		margin-block-start: var(--space-sm);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
	}

	.zones {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs) var(--space-md);
		margin-block-start: var(--space-sm);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.notice {
		max-width: var(--measure);
		padding: var(--space-md);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-sunken);
		color: var(--color-ink-muted);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	.notice--loud {
		border-inline-start: 3px solid var(--color-accent);
		background-color: var(--color-accent-wash);
		color: var(--color-ink);
	}

	.week + .week {
		margin-block-start: var(--space-xl);
	}

	.week__label {
		max-width: var(--measure);
		padding-block-end: var(--space-xs);
		border-block-end: 1px solid var(--color-line-strong);
		font-size: var(--text-base);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-ink-faint);
	}

	.day {
		max-width: var(--measure);
		margin-block-start: var(--space-lg);
	}

	.day__label {
		font-size: var(--text-lg);
	}

	.entries {
		margin: 0;
		padding: 0;
	}

	.entry {
		padding-block: var(--space-md);
		border-block-start: 1px solid var(--color-line);
	}

	.entry__when {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--color-ink);
	}

	.entry__spans,
	.entry__local {
		color: var(--color-ink-faint);
	}

	.entry__title {
		margin-block-start: var(--space-2xs);
		font-size: var(--text-lg);
	}

	.entry__busy {
		margin-block-start: var(--space-2xs);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
	}

	.entry__meta {
		margin-block-start: var(--space-2xs);
		color: var(--color-ink-muted);
		font-size: var(--text-sm);
	}

	.entry__meta--wrap {
		white-space: pre-wrap;
	}

	.signature {
		max-width: var(--measure);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
