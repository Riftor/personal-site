/**
 * Prerendering is declared here, inside the `(public)` group, and nowhere
 * higher up. Cloudflare serves static assets *before* the Worker runs, so a
 * prerendered page bypasses `hooks.server.ts` and every access check with it
 * (plan §2, "The Static Assets footgun"). A blanket `prerender = true` on the
 * root layout would therefore be inherited by the private half in M3 and fail
 * silently and successfully.
 *
 * These pages are not prerendered either: `content_entry` rows are published
 * straight to D1 by the CLI in §6 with no redeploy, so a build-time snapshot
 * would go stale the moment Caden publishes anything. They are server-rendered
 * per request against the D1 binding.
 */
export const prerender = false;
export const ssr = true;
