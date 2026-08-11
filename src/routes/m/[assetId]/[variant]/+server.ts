import { accessDecisionFor } from '$lib/server/access/guard';
import { findServableVariant } from '$lib/server/media/assets';
import { mediaResponse, mediaUnavailable, refuseMedia } from '$lib/server/media/response';
import { r2MediaStore } from '$lib/server/media/store';
import type { RequestHandler } from './$types';

/**
 * The byte path (plan §5, "Serving private media — the route that matters").
 *
 * Every private image, poster and video range in the site comes through here,
 * and the property the whole design rests on is that **a media URL is not a
 * bearer token**. There are no presigned URLs, the bucket has no public
 * hostname, and the tier is resolved from `access_grant` and re-checked
 * against the asset on every single fetch — every `<img>`, every poster, and
 * every one of the dozens of byte ranges a browser asks for while scrubbing a
 * video. Nothing here is cached, sessioned, or carried between requests, so a
 * revoked grant stops working on the next range request rather than at the end
 * of the video.
 *
 * The route is deliberately *not* under `/private`. The prefix table in
 * `access/routes.ts` turns an unauthenticated request for a private path into
 * a 302 to `/signin`, which is right for a page and wrong for a subresource:
 * an `<img>` cannot follow a login flow, so a stranger's request would render
 * as a broken image instead of a diagnosable 401. Being outside the table
 * costs nothing, because the check below does not consult it — it compares the
 * viewer's rank against the asset's own, through the same
 * `accessDecisionFor` the page guard uses.
 *
 * The order of the four steps is load-bearing:
 *
 *   1. Resolve the asset. `findServableVariant` returns `null` for anything it
 *      cannot prove — unknown id, unknown variant, orphaned asset, draft
 *      entry, a rank column that is not a rank, a failed query.
 *   2. `null` becomes `Infinity`, so an unknown asset is refused *exactly* as
 *      a private one is, with the same status and the same body. A probe
 *      cannot separate "does not exist" from "not yours".
 *   3. Decide. 401 with no session, 403 with an insufficient one.
 *   4. Only then touch R2.
 */

export const prerender = false;

export const GET: RequestHandler = async (event) => {
	const { platform, params, request, locals } = event;

	const d1 = platform?.env?.DB;
	const bucket = platform?.env?.MEDIA;
	if (!d1 || !bucket) {
		console.error('media: the DB or MEDIA binding is missing; refusing to serve anything.');
		return mediaUnavailable(500);
	}

	const record = await findServableVariant(d1, params.assetId, params.variant);

	// Default deny, stated as arithmetic: no record means a rank nobody holds,
	// which then flows through exactly the same decision as a real asset.
	const requiredRank = record?.requiredRank ?? Number.POSITIVE_INFINITY;
	const decision = accessDecisionFor(locals.viewer, requiredRank);

	if (decision !== 'allow') return refuseMedia(decision);

	// Unreachable — `allow` needs a finite rank and only a record supplies one
	// — but it is the branch that would serve bytes with no rank behind them,
	// so it refuses rather than trusting the reasoning above.
	if (!record) return refuseMedia('forbidden');

	const object = await r2MediaStore(bucket).get(record.r2Key, {
		range: request.headers,
		onlyIf: request.headers
	});

	// The row promised an object that is not there. That is a broken publish,
	// not a permission problem, and the viewer was already authorized — so it
	// is safe to say so, and useful to.
	if (!object) {
		console.error(`media: ${record.r2Key} is in media_variant but not in R2.`);
		return mediaUnavailable(404);
	}

	return mediaResponse(request, object, { mime: record.mime, requiredRank });
};
