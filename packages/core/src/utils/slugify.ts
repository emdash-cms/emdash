export { slugify } from "@emdash-cms/admin/slugify";

/**
 * Decode a URI-encoded slug parameter.
 *
 * Browsers percent-encode non-ASCII characters in URLs, so a slug like
 * "మేష-రాసి" arrives as "%e0%b0%ae%e0%b1%87%e0%b0%b7-%e0%b0%b0%e0%b0%be%e0%b0%b8%e0%b0%bf".
 * Call this on `Astro.params.slug` before using it in database lookups.
 *
 * Returns `undefined` for malformed escapes and for slugs containing a NUL
 * byte, which PostgreSQL rejects in text parameters.
 */
export function decodeSlug(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	let slug: string;
	try {
		slug = decodeURIComponent(raw);
	} catch {
		return undefined;
	}
	return slug.includes("\0") ? undefined : slug;
}
