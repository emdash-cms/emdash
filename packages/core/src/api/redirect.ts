// eslint-disable-next-line no-control-regex -- rejecting control characters is the whole point of this regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validate that a redirect URL is a safe local path.
 *
 * Rejects:
 * - Protocol-relative URLs (`//evil.com`)
 * - Backslash bypass (`/\evil.com` — browsers normalize `\` to `/` in Location headers)
 * - Control characters (`/\t/evil.com` — browsers strip tab/CR/LF, leaving `//evil.com`)
 * - Absolute URLs (`https://evil.com`)
 * - Empty / nullish values
 */
export function isSafeRedirect(url: string | null | undefined): url is string {
	return (
		typeof url === "string" &&
		url.startsWith("/") &&
		!url.startsWith("//") &&
		!url.includes("\\") &&
		!CONTROL_CHARACTERS.test(url)
	);
}
