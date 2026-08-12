<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Memory = PageProps['data']['memories'][number];

	function when(occurredOn: string | null): string {
		if (!occurredOn) return '';

		const date = new Date(`${occurredOn}T00:00:00Z`);
		return Number.isNaN(date.getTime())
			? occurredOn
			: date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
	}

	/**
	 * The smallest image of the first asset a viewer may see, as the card's
	 * thumbnail. It is `null` for a written memory with no photos, and for one
	 * whose photos are all above the viewer's tier — the loader has already
	 * dropped those assets, so there is nothing here to decide.
	 */
	function thumbnail(memory: Memory): { src: string; placeholder: string | null } | null {
		for (const asset of memory.assets) {
			const variant =
				asset.variants.find((candidate) => candidate.name === 'w400.webp') ??
				asset.variants.find((candidate) => candidate.name === 'poster.jpg');

			if (variant) return { src: `/m/${asset.id}/${variant.name}`, placeholder: asset.placeholder };
		}
		return null;
	}
</script>

<svelte:head>
	<title>Memories — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow">Private · family and above</p>
		<h1>Memories</h1>
		<p class="lede__summary">
			Trips, days out, and the things worth writing down afterwards. Some of these are stricter than
			this page; those are not listed here at all.
		</p>
	</header>

	<ul class="cards" role="list">
		{#each data.memories as memory (memory.slug)}
			{@const thumb = thumbnail(memory)}
			<li>
				<a class="card" href={resolve('/(private)/private/memories/[slug]', { slug: memory.slug })}>
					<span
						class="card__thumb"
						style:background-image={thumb?.placeholder ? `url("${thumb.placeholder}")` : null}
					>
						{#if thumb}
							<img src={thumb.src} alt="" loading="lazy" decoding="async" />
						{/if}
					</span>
					<span class="card__text">
						<span class="card__title">{memory.title}</span>
						{#if memory.occurredOn}
							<time class="card__date" datetime={memory.occurredOn}>{when(memory.occurredOn)}</time>
						{/if}
						{#if memory.summary}
							<span class="card__summary">{memory.summary}</span>
						{/if}
					</span>
				</a>
			</li>
		{:else}
			<li class="prose">No memories have been published to your tier yet.</li>
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

	.cards {
		display: grid;
		gap: var(--space-lg);
		margin: 0;
		grid-template-columns: repeat(auto-fill, minmax(min(20rem, 100%), 1fr));
	}

	.card {
		display: grid;
		overflow: hidden;
		border: 1px solid var(--color-line);
		border-radius: var(--radius-lg);
		color: inherit;
		text-decoration: none;
	}

	.card:hover {
		border-color: var(--color-line-strong);
	}

	.card__thumb {
		display: block;
		aspect-ratio: 3 / 2;
		background-color: var(--color-surface-sunken);
		background-position: center;
		background-size: cover;
	}

	.card__thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.card__text {
		display: grid;
		gap: var(--space-2xs);
		padding: var(--space-md);
	}

	.card__title {
		font-size: var(--text-lg);
		font-weight: 600;
	}

	.card__date {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.card__summary {
		color: var(--color-ink-muted);
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
