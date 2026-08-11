<script lang="ts">
	import { resolve } from '$app/paths';

	let { data } = $props();
</script>

<svelte:head>
	<title>Sign in — Caden</title>
	<!-- A sign-in page has nothing to offer a crawler and every reason not to
	     appear in results. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="signin">
	<p class="eyebrow">Sign in</p>
	<h1>Continue with Google</h1>

	{#if data.viewerEmail}
		<p class="prose">
			You are already signed in as <strong>{data.viewerEmail}</strong>. Signing in with a different
			Google account replaces this one.
		</p>
	{:else}
		<p class="prose">
			Google is the only way in. Signing in proves which email address is yours — it is what the
			private half of the site is keyed to.
		</p>
	{/if}

	{#if data.errorMessage}
		<p class="notice" role="alert">{data.errorMessage}</p>
	{/if}

	<form method="POST" action="/signin/google?next={encodeURIComponent(data.next)}">
		<button class="button" type="submit">Continue with Google</button>
	</form>

	<p class="prose signin__note">
		Signing in on its own does not unlock anything. Access to the private pages is granted per
		address by Caden; without a grant you will see the public site exactly as you do now.
		{#if !data.viewerEmail}
			<a class="link-arrow" href={resolve('/')}>Back to the site</a>
		{/if}
	</p>
</div>

<style>
	.signin {
		max-width: var(--measure);
	}

	.signin > * + * {
		margin-block-start: var(--space-md);
	}

	.signin > * + form {
		margin-block-start: var(--space-lg);
	}

	.notice {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--color-line-strong);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-sunken);
		color: var(--color-ink);
		font-size: var(--text-sm);
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

	.signin__note {
		font-size: var(--text-sm);
	}
</style>
