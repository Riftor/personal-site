<script lang="ts">
	import MediaGrid from '$lib/components/MediaGrid.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Photos — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow">Private · family and above</p>
		<h1>Photos</h1>
		<p class="lede__summary">
			Every image and clip below is fetched through the Worker, which re-checks your tier on each
			request. Nothing here has a public URL.
		</p>
	</header>

	{#each data.sets as set (set.slug)}
		<section class="set">
			<header class="set__header">
				<h2>{set.title}</h2>
				{#if set.occurredOn}
					<p class="set__date">{set.occurredOn}</p>
				{/if}
				{#if set.summary}
					<p class="set__summary">{set.summary}</p>
				{/if}
				{#if set.bodyHtml}
					<!-- Rendered from markdown at publish time, with raw HTML escaped
					     rather than passed through — see scripts/content/markdown.mjs. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="prose">{@html set.bodyHtml}</div>
				{/if}
			</header>

			<MediaGrid assets={set.assets} />
		</section>
	{:else}
		<p class="prose">No photo sets have been published to your tier yet.</p>
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

	.set__header {
		max-width: var(--measure);
		margin-block-end: var(--space-lg);
	}

	.set__date {
		margin-block-start: var(--space-2xs);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.set__summary {
		margin-block-start: var(--space-xs);
		color: var(--color-ink-muted);
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
