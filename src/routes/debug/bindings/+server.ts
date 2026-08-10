import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// M0 scaffolding: proves the Cloudflare bindings reach the Worker under `wrangler dev`.
// Delete this route once real private routes exist — it is unguarded by design.
export const GET: RequestHandler = ({ platform }) =>
	json({
		DB: typeof platform?.env?.DB?.prepare === 'function',
		MEDIA: typeof platform?.env?.MEDIA?.get === 'function'
	});
