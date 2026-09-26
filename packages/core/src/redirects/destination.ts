/**
 * Browsers strip tab/CR/LF anywhere in a URL, so `/\t/evil.example` resolves
 * as `//evil.example`. Reject every C0 control and DEL rather than just those.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Returns true if `destination` is a single-slash site-relative path, i.e. a
 * browser resolves it on the current origin: no scheme, no `//` or `/\`
 * prefix, and no control characters.
 */
export function isSiteRelativeDestination(destination: string): boolean {
	return (
		destination.startsWith("/") &&
		destination[1] !== "/" &&
		destination[1] !== "\\" &&
		!CONTROL_CHARS.test(destination)
	);
}
