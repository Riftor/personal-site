<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	let { children, data } = $props();

	const nav = [
		{ href: resolve('/'), label: 'Home' },
		{ href: resolve('/about'), label: 'About' },
		{ href: resolve('/work'), label: 'Work' }
	];

	// Trailing slashes are normalised away by SvelteKit, so an exact match is enough.
	const current = $derived(page.url.pathname);
	const year = new Date().getFullYear();

	// Where sign-in should return to, and where sign-out should leave you.
	// Never `/signin` itself, which would bounce a fresh session straight back
	// to the page it just came from, and never a private path — `/signout`
	// refuses to send you back to one anyway (it would need the session it just
	// destroyed), and echoing the path here would make the masthead the one
	// part of a refusal page that differs between a private URL that exists and
	// one that does not.
	const next = $derived(
		current.startsWith('/private') || current === resolve('/signin')
			? '/'
			: current + page.url.search
	);
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

					<!-- Links to the private half, for tiers that clear it. This is
					     signposting, not access control: every page below refuses
					     the request in its own loader, and typing the URL without
					     the link gets you exactly as far. -->
					{#each data.privateNav as item (item.href)}
						<li>
							<a
								class="nav__private"
								href={item.href}
								aria-current={current === item.href ? 'page' : undefined}
							>
								{item.label}
							</a>
						</li>
					{/each}
				</ul>
			</nav>

			<!-- Identity only. Showing an email here says who Google says you
			     are; it says nothing about what you may read. -->
			<div class="viewer">
				{#if data.viewerEmail}
					<span class="viewer__email" title={data.viewerEmail}>{data.viewerEmail}</span>
					<form method="POST" action="/signout?next={encodeURIComponent(next)}">
						<button class="viewer__button" type="submit">Sign out</button>
					</form>
				{:else}
					<a class="viewer__link" href="{resolve('/signin')}?next={encodeURIComponent(next)}">
						Sign in
					</a>
				{/if}
			</div>
		</div>
	</header>

	<main id="main" class="shell">
		{@render children()}
	</main>

	<footer class="colophon">
		<div class="shell colophon__inner">
			<p>&copy; {year} Caden</p>
			<p class="colophon__note">
				<a href="mailto:cadenedam@gmail.com">cadenedam@gmail.com</a>
			</p>
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

	/* The one piece of branding on the site, so it gets the display face at a
	   size the nav beside it does not compete with. */
	.wordmark {
		color: var(--color-ink);
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 600;
		letter-spacing: var(--tracking-tight);
		text-decoration: none;
	}

	.wordmark:hover {
		color: var(--color-accent);
	}

	.nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md) var(--space-lg);
		margin: 0;
		font-size: var(--text-sm);
	}

	.nav a {
		display: inline-block;
		padding-block-end: 3px;
		border-block-end: 1px solid transparent;
		color: var(--color-ink-muted);
		font-weight: 500;
		text-decoration: none;
	}

	.nav a:hover {
		border-block-end-color: var(--color-line-strong);
		color: var(--color-ink);
	}

	/* The current page is marked by weight and a solid accent rule, so it still
	   reads when the underline is the only thing hover changes. */
	.nav a[aria-current='page'] {
		border-block-end-color: var(--color-accent);
		color: var(--color-ink);
		font-weight: 600;
	}

	/* Marks the private half apart from the portfolio so it is obvious which
	   links a signed-out visitor is not seeing. */
	.nav__private {
		color: var(--color-accent);
	}

	.viewer {
		display: flex;
		align-items: baseline;
		gap: var(--space-sm);
		min-width: 0;
		font-size: var(--text-sm);
	}

	/* A long address must truncate rather than push the nav off a phone. */
	.viewer__email {
		overflow: hidden;
		color: var(--color-ink-faint);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Sign-in is the only thing in the masthead that starts a flow, so it is the
	   only thing shaped like a control rather than a link. */
	.viewer__link {
		padding: var(--space-2xs) var(--space-sm);
		border: 1px solid var(--color-line-strong);
		border-radius: var(--radius-pill);
		color: var(--color-ink);
		font-weight: 550;
		text-decoration: none;
	}

	.viewer__link:hover {
		border-color: var(--color-accent);
		background-color: var(--color-accent-wash);
		color: var(--color-accent-hover);
	}

	/* Sign-out has to be a form button so it can POST; it is styled to read as
	   the link it sits next to rather than as a call to action. */
	.viewer__button {
		padding: 0;
		border: 0;
		background: none;
		color: var(--color-ink-muted);
		font-size: inherit;
		cursor: pointer;
	}

	.viewer__button:hover {
		color: var(--color-ink);
		text-decoration: underline;
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

	/* Quiet by default — this is the last line on the page, not a call to
	   action — but unmistakably a link on hover. */
	.colophon__note a {
		color: var(--color-ink-muted);
		text-decoration-color: var(--color-line-strong);
	}

	.colophon__note a:hover {
		color: var(--color-accent);
		text-decoration-color: currentcolor;
	}
</style>
