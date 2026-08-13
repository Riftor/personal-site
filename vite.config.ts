import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),

			/**
			 * Content Security Policy (plan §7.4).
			 *
			 * This lives in Kit's config rather than in `hooks.server.ts`
			 * because Kit emits the inline `<script>` that boots hydration and
			 * the inline `<style>` blocks it inlines with it. Only Kit can
			 * nonce those, so a hand-written `script-src` in `handle` would
			 * have to say `'unsafe-inline'` — which browsers then use to
			 * *ignore* every nonce and hash in the same directive, leaving a
			 * header that scans well and protects nothing. The headers Kit does
			 * not own (HSTS, Referrer-Policy, X-Frame-Options,
			 * X-Content-Type-Options, Permissions-Policy) are in
			 * `$lib/server/security-headers`.
			 *
			 * `mode: 'hash'`, and that is a security decision rather than a
			 * preference. A nonce is regenerated per response, so two 403 pages
			 * differ by sixteen random bytes — which broke three existing e2e
			 * tests outright (`access.spec.ts`, `content.spec.ts`) and, more to
			 * the point, broke the invariant they guard: a refusal for a
			 * private page that exists must be **byte-identical** to one for a
			 * page that does not, or the difference enumerates the private
			 * half. The nonce here is random rather than path-derived, so it
			 * leaked nothing on its own — but "identical apart from some noise"
			 * is not a property a test can check, and this project's refusals
			 * are compared byte for byte on purpose. A hash of Kit's own inline
			 * bootstrap is deterministic, so the refusals stay identical and
			 * the header stays stable. Hashes are no weaker than nonces here:
			 * both authorise exactly the script SvelteKit emitted.
			 *
			 * Every entry below that is not `'self'` or `'none'` names the
			 * concrete thing that needs it.
			 */
			csp: {
				mode: 'hash',
				directives: {
					// The floor. Everything without a directive of its own —
					// `manifest-src`, `prefetch-src`, `child-src` — lands here.
					'default-src': ['self'],

					// Kit appends a `'sha256-…'` to `script-src` for the inline
					// bootstrap it emits, and would do the same to `style-src`
					// if it ever inlined a `<style>` — it does not at the
					// default `inlineStyleThreshold`, so the site's CSS arrives
					// as a same-origin `<link>` and this stays a bare `'self'`.
					// Both are listed rather than left to `default-src` on
					// Kit's own advice: Firefox does not ignore a hash on
					// `default-src` the way the spec says it should.
					'script-src': ['self'],
					'style-src': ['self'],

					// `MediaGrid.svelte` and the memories index set
					// `style:aspect-ratio` and `style:background-image` on each
					// tile, which Svelte renders as a `style="…"` attribute in
					// the SSR HTML. An attribute cannot carry a nonce and its
					// content is per-asset, so it cannot be hashed either.
					// Scoped to `-attr`, so `<style>` and `<link>` elements are
					// still nonce-only. Supported since Firefox 105 / Chrome 75
					// / Safari 15.4, so no browser falls back to `style-src`
					// here and blocks the placeholders.
					'style-src-attr': ['unsafe-inline'],

					// `data:` is the blurhash placeholder: `blurhash.ts` encodes
					// a 4-row BMP and inlines it as a data URI so a gated tile
					// has something to show before its `/m/…` request resolves.
					// Every real image is same-origin — there is no CDN and no
					// public bucket (plan §5), by design.
					'img-src': ['self', 'data:'],
					'media-src': ['self'],
					'font-src': ['self'],

					// Hydration's `__data.json` fetches, and nothing else. The
					// site talks to no third-party API from the browser.
					'connect-src': ['self'],

					// `accounts.google.com` is the Google sign-in hop. The form
					// on `/signin` posts same-origin to `/signin/google`, which
					// answers 302 to Google's authorize endpoint, and
					// `form-action` is enforced across that redirect — so
					// `'self'` alone breaks sign-in.
					//
					// **Do not remove this entry, and do not trust a Chrome-only
					// check that says it is unnecessary.** An earlier version of
					// this comment claimed the enforcement was Firefox-only.
					// That was true once and is not any more: Chromium adopted
					// it in crbug 1359351 (~Chrome 130), and the M7.4 review
					// confirmed by execution that current Chromium and Firefox
					// both block the redirect without this entry and both
					// succeed with it. Nothing in the suite would catch the
					// removal either — `e2e/signin.spec.ts` drives the hop
					// through an API request context, which does not enforce
					// CSP at all, and says so in its own header comment.
					//
					// This is the *destination of a top-level navigation*, not
					// a fetch and not a frame: Google needs no `connect-src`
					// and no `frame-src` entry. Better Auth's own POSTs to
					// `/api/auth/*` are covered by `'self'`.
					'form-action': ['self', 'https://accounts.google.com'],

					'base-uri': ['self'],
					'object-src': ['none'],
					'frame-src': ['none'],
					// No service worker and no Web Worker. Delete this the day
					// one is added rather than widening it.
					'worker-src': ['none'],
					// The real version of `X-Frame-Options: DENY`.
					'frame-ancestors': ['none']
				}
			},

			typescript: {
				config: (config) => {
					config.include.push('../drizzle.config.ts');
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					// `scripts/` is in here because the media pipeline lives
					// there: the EXIF-stripping proof in `derive.spec.mjs` is
					// a privacy control (plan §8), not a build helper, and it
					// belongs in the suite that has to stay green.
					include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,mjs,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
