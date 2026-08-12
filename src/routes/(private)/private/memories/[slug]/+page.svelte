<script lang="ts">
	import { resolve } from '$app/paths';
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const occurredOn = $derived(data.memory.occurredOn);

	const when = $derived.by(() => {
		if (!occurredOn) return '';

		const date = new Date(`${occurredOn}T00:00:00Z`);
		return Number.isNaN(date.getTime())
			? occurredOn
			: date.toLocaleDateString('en-GB', {
					day: 'numeric',
					month: 'long',
					year: 'numeric',
					timeZone: 'UTC'
				});
	});
</script>

<svelte:head>
	<title>{data.memory.title} — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow"><a href={resolve('/(private)/private/memories')}>Memories</a></p>
		<h1>{data.memory.title}</h1>
		{#if occurredOn}
			<p class="lede__date"><time datetime={occurredOn}>{when}</time></p>
		{/if}
		{#if data.memory.summary}
			<p class="lede__summary">{data.memory.summary}</p>
		{/if}
	</header>

	{#if data.memory.bodyHtml}
		<!-- Rendered from markdown at publish time, with raw HTML escaped rather
		     than passed through — see scripts/content/markdown.mjs. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<div class="prose">{@html data.memory.bodyHtml}</div>
	{/if}

	{#if data.memory.assets.length > 0}
		<MediaGrid assets={data.memory.assets} />
	{/if}

	<p class="signature">Signed in as {data.viewer.email} ({data.viewer.tierSlug}).</p>
</article>

<style>
	.lede {
		max-width: var(--measure);
	}

	.lede__date {
		margin-block-start: var(--space-2xs);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.lede__summary {
		margin-block-start: var(--space-sm);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
