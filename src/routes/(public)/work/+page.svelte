<script lang="ts">
	import ProjectCard from '$lib/components/ProjectCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.page.title} — Caden</title>
	{#if data.page.summary}
		<meta name="description" content={data.page.summary} />
	{/if}
</svelte:head>

<div class="stack-page">
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

	<section>
		<h2 class="visually-hidden">Projects</h2>
		<ul class="project-list" role="list">
			{#each data.projects as project (project.slug)}
				<li>
					<ProjectCard
						title={project.title}
						summary={project.summary}
						occurredOn={project.occurredOn}
						level={3}
					/>
				</li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.lede {
		max-width: var(--measure);
	}

	.lede__summary {
		margin-block-start: var(--space-sm);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.project-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
		gap: var(--space-md);
		margin: 0;
	}
</style>
