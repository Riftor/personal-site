<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Now — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow">Private · friend and above</p>
		<h1>Now</h1>
		<p class="lede__summary">What I am actually up to, as of {data.updatedOn}.</p>
	</header>

	<ul class="entries" role="list">
		{#each data.items as item (item)}
			<li>{item}</li>
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

	.entries {
		max-width: var(--measure);
		margin: 0;
	}

	.entries li {
		padding-block: var(--space-md);
		border-block-start: 1px solid var(--color-line);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
