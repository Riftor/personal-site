<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.page.title} — Caden</title>
	{#if data.page.summary}
		<meta name="description" content={data.page.summary} />
	{/if}
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<h1>{data.page.title}</h1>
		{#if data.page.summary}
			<p class="lede__summary">{data.page.summary}</p>
		{/if}
	</header>

	{#if data.page.bodyHtml}
		<!-- Trusted at publish time — see the note on the home page and plan §6. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<div class="prose">{@html data.page.bodyHtml}</div>
	{/if}
</article>

<style>
	.lede {
		max-width: var(--measure);
	}

	.lede__summary {
		max-width: var(--measure-lead);
		margin-block-start: var(--space-sm);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
	}
</style>
