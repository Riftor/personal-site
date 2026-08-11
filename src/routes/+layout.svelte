<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	let { children } = $props();

	const nav = [
		{ href: resolve('/'), label: 'Home' },
		{ href: resolve('/about'), label: 'About' },
		{ href: resolve('/work'), label: 'Work' }
	];

	// Trailing slashes are normalised away by SvelteKit, so an exact match is enough.
	const current = $derived(page.url.pathname);
	const year = new Date().getFullYear();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>

<div class="frame">
	<header class="masthead">
		<div class="shell masthead__inner">
			<a class="wordmark" href={resolve('/')}>Caden</a>
			<nav aria-label="Primary">
				<ul class="nav" role="list">
					{#each nav as item (item.href)}
						<li>
							<a href={item.href} aria-current={current === item.href ? 'page' : undefined}>
								{item.label}
							</a>
						</li>
					{/each}
				</ul>
			</nav>
		</div>
	</header>

	<main id="main" class="shell">
		{@render children()}
	</main>

	<footer class="colophon">
		<div class="shell colophon__inner">
			<p>&copy; {year} Caden</p>
			<p class="colophon__note">[PLACEHOLDER] — links to wherever you want to be found.</p>
		</div>
	</footer>
</div>

<style>
	/* Sticks the footer to the bottom on pages shorter than the viewport. */
	.frame {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
	}

	main {
		flex: 1;
		padding-block: var(--space-2xl) var(--space-3xl);
	}

	.masthead {
		border-block-end: 1px solid var(--color-line);
		background-color: var(--color-surface);
	}

	.masthead__inner {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-xs) var(--space-lg);
		padding-block: var(--space-md);
	}

	.wordmark {
		color: var(--color-ink);
		font-size: var(--text-lg);
		font-weight: 620;
		letter-spacing: var(--tracking-tight);
		text-decoration: none;
	}

	.nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin: 0;
		font-size: var(--text-sm);
	}

	.nav a {
		display: inline-block;
		padding-block-end: 2px;
		border-block-end: 2px solid transparent;
		color: var(--color-ink-muted);
		text-decoration: none;
	}

	.nav a:hover {
		color: var(--color-ink);
	}

	.nav a[aria-current='page'] {
		border-block-end-color: var(--color-accent);
		color: var(--color-ink);
	}

	.colophon {
		border-block-start: 1px solid var(--color-line);
		background-color: var(--color-surface-sunken);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.colophon__inner {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-2xs) var(--space-lg);
		padding-block: var(--space-lg);
	}

	.colophon__note {
		color: var(--color-ink-faint);
	}
</style>
