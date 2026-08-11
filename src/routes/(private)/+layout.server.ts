/**
 * The Static Assets footgun, closed (plan §2).
 *
 * Cloudflare serves static assets *before* the Worker runs. A private page
 * prerendered into an HTML file would therefore be handed to anyone who asked
 * for it with `hooks.server.ts` — and every access check in this codebase —
 * never executing. It is the one failure mode here that fails silently and
 * successfully, which is why it gets three independent controls rather than
 * one:
 *
 *  1. `prerender = false` here, inherited by every route in this group.
 *  2. `ssr = true` here, so private content is rendered on the server behind
 *     the guard rather than fetched by a public shell on the client.
 *  3. `scripts/assert-no-private-prerender.mjs`, wired into `pnpm build`,
 *     which fails the build if either of the two above is ever undone or if
 *     any HTML lands in the build output.
 *
 * There is deliberately no `load` in this file. The error boundary for this
 * group is `(private)/+error.svelte`, which sits at the same level — an error
 * thrown from *this* load would bubble past it to the root error page and the
 * 403 would lose the styled page that names the signed-in account. The guard
 * therefore lives in each `+page.server.ts`, which is where plan §2 puts it
 * anyway: on the data path, not on the layout.
 */
export const prerender = false;
export const ssr = true;
