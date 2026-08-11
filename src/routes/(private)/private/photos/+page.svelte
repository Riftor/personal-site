<script lang="ts">
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
			Curated sets. The images themselves arrive in M4, served through the Worker so every fetch
			re-checks the tier.
		</p>
	</header>

	<ul class="sets" role="list">
		{#each data.sets as set (set.title)}
			<li>
				<h2>{set.title}</h2>
				<p>{set.count} photos</p>
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

	.sets {
		display: grid;
		gap: var(--space-lg);
		margin: 0;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
	}

	.sets li {
		padding: var(--space-lg);
		border: 1px solid var(--color-line);
		border-radius: var(--radius-lg);
		background-color: var(--color-surface);
	}

	.sets h2 {
		font-size: var(--text-lg);
	}

	.sets p {
		margin-block-start: var(--space-2xs);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
