<script lang="ts">
	import { formatOccurredOn } from '$lib/content';
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
		<!-- One entry per project, read top to bottom, rather than a grid of
		     summary cards. There are rarely more than a handful of these and the
		     body is the point of the page, so a card that hides it is a link with
		     extra steps. -->
		<ol class="entries" role="list">
			{#each data.projects as project (project.slug)}
				{@const when = formatOccurredOn(project.occurredOn)}
				<li class="entry">
					{#if when}
						<p class="eyebrow"><time datetime={project.occurredOn}>{when}</time></p>
					{/if}
					<h3 class="entry__title">{project.title}</h3>
					{#if project.summary}
						<p class="entry__lead">{project.summary}</p>
					{/if}
					{#if project.bodyHtml}
						<!-- `body_html` is rendered from markdown at publish time and stored
						     in D1. It is trusted-at-publish-time, not sanitised here: Caden is
						     the only author and nothing user-submitted ever reaches this
						     column. If that ever stops being true, this is the line that
						     breaks. -->
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<div class="prose entry__body">{@html project.bodyHtml}</div>
					{/if}
				</li>
			{/each}
		</ol>
	</section>
</div>

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

	/* Same reasoning as the home page: summary and intro are one thought. */
	.lede + .prose {
		margin-block-start: var(--space-xl);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.entries {
		margin: 0;
		padding: 0;
	}

	/* A hairline between entries and nothing around them: the rule is doing the
	   separating a card's border and shadow used to, with less furniture. */
	.entry + .entry {
		margin-block-start: var(--space-2xl);
		padding-block-start: var(--space-2xl);
		border-block-start: 1px solid var(--color-line);
	}

	.entry__title {
		max-width: var(--measure);
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		font-weight: 600;
	}

	/* The lead sits directly above the body here, so it takes the body's measure
	   rather than the narrower lead one: a 46ch lead over a 65ch body reads as a
	   ragged column that changes its mind. */
	.entry__lead {
		max-width: var(--measure);
		margin-block-start: var(--space-sm);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
		line-height: var(--leading-snug);
	}

	/* The body is the smaller voice under the lead, so it drops back to base
	   size rather than the `.prose` default. */
	.entry__body {
		margin-block-start: var(--space-lg);
		font-size: var(--text-base);
	}
</style>
