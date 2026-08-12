<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** "August 2026" from the `occurred_on` the frontmatter set. */
	function monthLabel(occurredOn: string | null, fallback: string): string {
		if (!occurredOn) return fallback;

		const date = new Date(`${occurredOn}T00:00:00Z`);
		return Number.isNaN(date.getTime())
			? fallback
			: date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
	}

	const updated = $derived(data.months[0]?.updatedAt ?? null);
</script>

<svelte:head>
	<title>Now — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow">Private · friend and above</p>
		<h1>Now</h1>
		<p class="lede__summary">
			What I am actually up to, a month at a time.
			{#if updated}
				Last updated {new Date(updated * 1000).toLocaleDateString('en-GB', {
					day: 'numeric',
					month: 'long',
					year: 'numeric'
				})}.
			{/if}
		</p>
	</header>

	{#each data.months as month (month.slug)}
		<section class="month">
			<h2>{monthLabel(month.occurredOn, month.title)}</h2>
			{#if month.summary}
				<p class="month__summary">{month.summary}</p>
			{/if}
			{#if month.bodyHtml}
				<!-- Rendered from markdown at publish time, with raw HTML escaped
				     rather than passed through — see scripts/content/markdown.mjs. -->
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="prose">{@html month.bodyHtml}</div>
			{/if}
		</section>
	{:else}
		<p class="prose">Nothing has been published to your tier yet.</p>
	{/each}

	<p class="signature">Signed in as {data.viewer.email} ({data.viewer.tierSlug}).</p>
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

	.month {
		max-width: var(--measure);
		padding-block-start: var(--space-lg);
		border-block-start: 1px solid var(--color-line);
	}

	.month__summary {
		margin-block-start: var(--space-2xs);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
