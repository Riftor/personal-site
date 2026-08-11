/**
 * Validation for the `?next=` parameter the sign-in flow round-trips through
 * Google and back.
 *
 * The value ends up in a `Location` header, so an unchecked one is an open
 * redirect: a link to `/signin?next=https://evil.example` would hand a visitor
 * who has just typed their Google password to somebody else's page. Only a
 * same-origin *relative* path is accepted, and anything else falls back to the
 * home page rather than erroring — a bad `next` is not worth blocking a
 * legitimate sign-in over.
 */

/** Where a visitor lands when `next` is missing, malformed, or off-site. */
export const DEFAULT_REDIRECT = '/';

/**
 * Browsers strip tabs and newlines out of a URL before parsing it, so
 * `/\t/evil.example` reaches the network as `//evil.example` and slips past a
 * plain prefix check. Reject the whole C0 range plus DEL rather than guess.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeRedirectTarget(next: string | null | undefined): string {
	if (!next) return DEFAULT_REDIRECT;

	// Must be rooted, and must not be protocol-relative (`//host` parses as an
	// absolute URL) or the backslash variant of the same trick.
	if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
		return DEFAULT_REDIRECT;
	}

	if (CONTROL_CHARS.test(next)) return DEFAULT_REDIRECT;

	return next;
}
