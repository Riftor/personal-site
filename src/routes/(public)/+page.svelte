<script lang="ts">
	import ProjectCard from '$lib/components/ProjectCard.svelte';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Caden</title>
	{#if data.page.summary}
		<meta name="description" content={data.page.summary} />
	{/if}
</svelte:head>

<div class="stack-page">
	<section class="hero">
		<h1>{data.page.title}</h1>
		{#if data.page.summary}
			<p class="hero__lead">{data.page.summary}</p>
		{/if}
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
	.hero {
		max-width: var(--measure);
		padding-block: var(--space-xl) 0;
	}

	.hero__lead {
		margin-block-start: var(--space-md);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
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

	.card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
		gap: var(--space-md);
		margin: 0;
	}
</style>
