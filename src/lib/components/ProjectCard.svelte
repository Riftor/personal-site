<script lang="ts">
	import { formatOccurredOn } from '$lib/content';

	let {
		title,
		summary = null,
		occurredOn = null,
		/** Heading level, so the card sits correctly under whatever precedes it. */
		level = 3
	}: {
		title: string;
		summary?: string | null;
		occurredOn?: string | null;
		level?: 2 | 3;
	} = $props();

	const when = $derived(formatOccurredOn(occurredOn));
</script>

<article class="card">
	{#if when}
		<p class="eyebrow"><time datetime={occurredOn}>{when}</time></p>
	{/if}
	<svelte:element this={`h${level}`} class="card__title">{title}</svelte:element>
	{#if summary}
		<p class="card__summary">{summary}</p>
	{/if}
</article>

<style>
	.card {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: var(--space-lg);
		border: 1px solid var(--color-line);
		border-radius: var(--radius-lg);
		background-color: var(--color-surface);
		box-shadow: var(--shadow-sm);
	}

	.card__title {
		font-size: var(--text-xl);
	}

	.card__summary {
		margin-block-start: var(--space-xs);
		color: var(--color-ink-muted);
		font-size: var(--text-sm);
	}
</style>
