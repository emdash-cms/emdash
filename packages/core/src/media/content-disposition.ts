/**
 * Content-Disposition header construction for media downloads.
 *
 * The public media file route serves every non-inline type as an attachment.
 * Without a `filename` parameter the browser falls back to the last path
 * segment of the URL -- the storage key -- so a downloaded PDF lands in the
 * user's filesystem named after its ULID. These helpers build a header that
 * names the file the way the editor uploaded it.
 */

/**
 * Characters unsafe in a filename on one or more platforms, plus the quote and
 * backslash that would otherwise break out of the quoted `filename=` value.
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_FILENAME_CHARS = /[\x00-\x1F\x7F"\\/<>:|?*]/g;

/** Anything outside printable ASCII, carried by `filename*` instead. */
const NON_ASCII = /[^\x20-\x7E]/g;

/**
 * An ASCII-only, filesystem-safe rendering of `filename`, for the quoted
 * `filename=` parameter that older clients read.
 */
export function toAsciiFilename(filename: string): string {
	const cleaned = filename
		.normalize("NFKD")
		.replaceAll(UNSAFE_FILENAME_CHARS, "-")
		.replaceAll(NON_ASCII, "")
		.trim();
	return cleaned.length > 0 ? cleaned : "download";
}

/**
 * Build a `Content-Disposition` value.
 *
 * Emits both `filename` (ASCII, quoted) and RFC 5987 `filename*` (UTF-8
 * percent-encoded) so a name with non-ASCII characters survives. Returns the
 * bare disposition when no filename is known, which is the pre-existing
 * behaviour for media with no database row.
 */
export function contentDisposition(
	disposition: "inline" | "attachment",
	filename?: string | null,
): string {
	if (!filename) return disposition;
	const ascii = toAsciiFilename(filename);
	const encoded = encodeURIComponent(filename);
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
