/**
 * Turns a Better Auth API response into a browser redirect.
 *
 * `auth.api.*` called with `asResponse: true` answers with JSON plus the
 * `Set-Cookie` headers the flow depends on — the signed OAuth state cookie on
 * the way out, the session cookie's deletion on the way back. Copying those
 * headers verbatim onto a 303 keeps sign-in and sign-out working as plain form
 * posts, with no client-side auth bundle and no JavaScript requirement.
 */
export function redirectWithAuthCookies(from: Response, location: string): Response {
	const headers = new Headers({ location });
	for (const cookie of from.headers.getSetCookie()) {
		headers.append('set-cookie', cookie);
	}

	// 303 so the browser follows with GET; these endpoints are only ever
	// reached by a POST from a form.
	return new Response(null, { status: 303, headers });
}
