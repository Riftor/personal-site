import { createAuth } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/**
 * Every Better Auth endpoint, including the Google callback at
 * `/api/auth/callback/google` — a path that is registered in Google's console
 * and cannot be changed here without editing it there too.
 *
 * The handler's own `Response` is returned untouched so its `Set-Cookie`
 * headers reach the browser exactly as Better Auth wrote them.
 *
 * This is the one route where Better Auth creates a `session` row, so it is
 * also the one route whose headers reach the `signin` audit hook. They are
 * passed for `CF-Connecting-IP` and nothing else (plan §8.2).
 */
const handle: RequestHandler = ({ request, url, platform }) =>
	createAuth(platform, url.origin, request.headers).handler(request);

export const GET = handle;
export const POST = handle;
