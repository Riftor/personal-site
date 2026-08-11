<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Calendar — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow">Private · partner</p>
		<h1>Calendar</h1>
		<p class="lede__summary">
			Times are {data.timezone}. The live feed arrives in M5; these are placeholders.
		</p>
	</header>

	<ul class="blocks" role="list">
		{#each data.blocks as block (block.when)}
			<li>
				<span class="blocks__when">{block.when}</span>
				<span class="blocks__label">{block.label}</span>
			</li>
		{/each}
	</ul>

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

	.blocks {
		max-width: var(--measure);
		margin: 0;
	}

	.blocks li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-sm);
		padding-block: var(--space-md);
		border-block-start: 1px solid var(--color-line);
	}

	.blocks__when {
		color: var(--color-ink);
	}

	.blocks__label {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
