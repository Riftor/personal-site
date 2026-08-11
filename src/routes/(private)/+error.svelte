<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	/**
	 * The refusal page for the private half (plan §2).
	 *
	 * It renders **no page content** — it cannot, because the loader threw
	 * before returning any. What it does render is the one thing that makes the
	 * commonest real failure self-diagnosable: which Google account the
	 * browser is currently signed in as. Being signed into the wrong account is
	 * what actually happens to people, and a bare "403" leaves them stuck.
	 *
	 * It deliberately never redirects to `/signin`: this visitor is already
	 * authenticated, so a redirect would loop and hide the real problem.
	 *
	 * The copy is identical whether the private URL exists or not, so probing
	 * cannot enumerate the private half.
	 */
	const email = $derived(page.error?.email ?? page.data?.viewerEmail ?? null);
	const forbidden = $derived(page.status === 403);

	// Back to the page they came from, never to a private one.
	const next = $derived(page.url.pathname.startsWith('/private') ? '/' : page.url.pathname);
</script>

<svelte:head>
	<title>No access — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="refusal">
	<p class="eyebrow">{page.status}</p>
	<h1>{forbidden ? 'No access.' : 'Not found.'}</h1>

	{#if forbidden}
		{#if email}
			<p class="prose">
				You are signed in as <strong>{email}</strong>. That address does not have access to this
				page.
			</p>
		{:else}
			<p class="prose">That account does not have access to this page.</p>
		{/if}

		<p class="prose">
			If you were expecting to get in, the likeliest explanation is that the browser is signed into
			a different Google account from the one Caden granted.
		</p>

		<div class="actions">
			<form method="POST" action="/signout?next={encodeURIComponent(next)}">
				<button class="button" type="submit">Sign out and try another account</button>
			</form>
			<a
				class="link-arrow"
				href="mailto:cadenedam@gmail.com?subject=Access%20to%20the%20private%20pages"
			>
				Ask Caden for access
			</a>
		</div>
	{:else}
		<p class="prose">{page.error?.message ?? 'That page does not exist.'}</p>
	{/if}

	<p class="prose refusal__note">
		<a class="link-arrow" href={resolve('/')}>Back to the public site</a>
	</p>
</div>

<style>
	.refusal {
		max-width: var(--measure);
	}

	.refusal > * + * {
		margin-block-start: var(--space-md);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-md);
		margin-block-start: var(--space-lg);
	}

	.button {
		padding: var(--space-sm) var(--space-lg);
		border: 0;
		border-radius: var(--radius-pill);
		background-color: var(--color-accent);
		color: var(--color-on-accent);
		font-size: var(--text-base);
		font-weight: 550;
		cursor: pointer;
	}

	.button:hover {
		background-color: var(--color-accent-hover);
	}

	.refusal__note {
		font-size: var(--text-sm);
	}
</style>
