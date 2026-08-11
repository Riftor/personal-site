<!--
	Unreachable. The loader in `+page.server.ts` throws on every path — a
	redirect, a 403, or a 404 — so this component never renders. It exists only
	because SvelteKit requires a `+page.svelte` alongside a `+page.server.ts`,
	and it is deliberately empty so that if it ever *did* render it would leak
	nothing.
-->
