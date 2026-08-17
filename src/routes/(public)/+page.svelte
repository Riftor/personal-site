<script lang="ts">
	import ProjectCard from '$lib/components/ProjectCard.svelte';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.page.title}</title>
	{#if data.page.summary}
		<meta name="description" content={data.page.summary} />
	{/if}
</svelte:head>

<div class="stack-page">
	<section class="hero">
		<div class="hero__text">
			<h1>{data.page.title}</h1>
			{#if data.page.summary}
				<p class="hero__lead">{data.page.summary}</p>
			{/if}
		</div>
		<!-- A stand-in until there is a real photograph: drop one into `static/`
		     and change this src. Width/height are the SVG's own 4:5 box, so the
		     layout doesn't shift when a real file with other dimensions lands —
		     `object-fit: cover` crops it to the same frame instead. -->
		<img class="hero__portrait" src="/portrait.svg" alt="Caden Edam" width="800" height="1000" />
	</section>

	{#if data.page.bodyHtml}
		<!-- `body_html` is rendered from markdown at publish time by the CLI in plan
		     §6 and stored in D1. It is trusted-at-publish-time, not sanitised here:
		     Caden is the only author and nothing user-submitted ever reaches this
		     column. If that ever stops being true, this is the line that breaks. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<section class="prose">{@html data.page.bodyHtml}</section>
	{/if}

	{#if data.featured.length > 0}
		<section>
			<div class="section-head">
				<h2>Selected work</h2>
				<a class="link-arrow" href={resolve('/work')}>All work</a>
			</div>
			<ul class="card-grid" role="list">
				{#each data.featured as project (project.slug)}
					<li>
						<ProjectCard
							title={project.title}
							summary={project.summary}
							occurredOn={project.occurredOn}
						/>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	/* Name on the left, portrait on the right; the portrait drops below the
	   text when the row runs out of room rather than squeezing either. */
	.hero {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xl) var(--space-2xl);
		align-items: flex-start;
		padding-block: var(--space-xl) 0;
	}

	.hero__text {
		flex: 1 1 24rem;
		max-width: var(--measure);
	}

	.hero__portrait {
		flex: 0 1 auto;
		width: clamp(11rem, 26vw, 16rem);
		aspect-ratio: 4 / 5;
		object-fit: cover;
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-line);
	}

	/* A short accent rule instead of a wash: it marks the top of the page in the
	   site's one colour without putting a tint behind the headline. */
	.hero__text::before {
		content: '';
		display: block;
		width: 2.5rem;
		height: 2px;
		margin-block-end: var(--space-lg);
		background-color: var(--color-accent);
	}

	/* The one place the display face gets to be a display face. */
	.hero h1 {
		font-size: var(--text-5xl);
		line-height: var(--leading-display);
		letter-spacing: var(--tracking-tighter);
	}

	.hero__lead {
		max-width: var(--measure-lead);
		margin-block-start: var(--space-lg);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
		line-height: var(--leading-snug);
	}

	/* The lead and the intro paragraph are one thought in two parts. The page's
	   default section gap makes them read as two unrelated blocks. */
	.hero + .prose {
		margin-block-start: var(--space-xl);
	}

	.section-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-xs) var(--space-md);
		margin-block-end: var(--space-lg);
		padding-block-end: var(--space-xs);
		border-block-end: 1px solid var(--color-line);
	}

	/* Flex rather than a grid, because the count here is whatever is featured —
	   often one. An auto-fit grid gives a lone card either a stranded third of
	   the row or the full 64rem, and both read as a layout with a hole in it.
	   Wrapping flex items that grow from 17rem but stop at 26rem fill the row
	   when there are three and make a deliberate single card when there is one. */
	.card-grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin: 0;
	}

	.card-grid > li {
		flex: 1 1 17rem;
		max-width: 26rem;
	}

	/* A lone card capped at 26rem sits stranded under a section rule that spans
	   the full width. Letting it fill the row instead makes it read as a feature
	   rather than as the first of a set that never arrived. */
	.card-grid > li:only-child {
		max-width: none;
	}
</style>
