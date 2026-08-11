// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Viewer } from '$lib/server/access/viewer';

declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		/**
		 * Extra fields on the object `error(403, { … })` carries into
		 * `(private)/+error.svelte`. `email` is the account the visitor is
		 * signed in as, so the commonest real failure — signed into the wrong
		 * Google account — is self-diagnosable from the page.
		 */
		interface Error {
			code?: string;
			email?: string | null;
		}

		interface Locals {
			/** Set by `handle` on every request; never optional downstream. */
			viewer: Viewer;
		}

		// interface PageData {}
		// interface PageState {}
	}
}

export {};
