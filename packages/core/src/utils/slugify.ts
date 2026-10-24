import { normalizeSlugWhitespace } from "@emdash-cms/admin/slugify";

export { slugify } from "@emdash-cms/admin/slugify";

/**
 * The slug to store when a write sets one. A slug equal to the entry's current
 * slug is kept as stored, so saving an entry never moves a URL it already has.
 * Any other slug has whitespace trimmed from its ends, and each inner run of
 * whitespace, with any hyphens beside it, becomes one hyphen.
 */
export function normalizeIncomingSlug(slug: string, currentSlug?: string | null): string;
export function normalizeIncomingSlug(
	slug: string | null | undefined,
	currentSlug?: string | null,
): string | null | undefined;
export function normalizeIncomingSlug(
	slug: string | null | undefined,
	currentSlug?: string | null,
): string | null | undefined {
	if (typeof slug !== "string" || slug === currentSlug) return slug;
	return normalizeSlugWhitespace(slug);
}

/**
 * Decode a URI-encoded slug parameter.
 *
 * Browsers percent-encode non-ASCII characters in URLs, so a slug like
 * "మేష-రాసి" arrives as "%e0%b0%ae%e0%b1%87%e0%b0%b7-%e0%b0%b0%e0%b0%be%e0%b0%b8%e0%b0%bf".
 * Call this on `Astro.params.slug` before using it in database lookups.
 */
export function decodeSlug(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		return decodeURIComponent(raw);
	} catch {
		return undefined;
	}
}
