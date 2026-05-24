// Regex patterns for slug normalization
const DIACRITICS_PATTERN = /[\u0300-\u036f]/g;
const WHITESPACE_UNDERSCORE_PATTERN = /[\s_]+/g;
const NON_ALPHANUMERIC_HYPHEN_PATTERN = /[^a-z0-9-]/g;
const MULTIPLE_HYPHENS_PATTERN = /-+/g;
const LEADING_TRAILING_HYPHEN_PATTERN = /^-|-$/g;
const TRAILING_HYPHEN_PATTERN = /-$/;

/**
 * Convert a string to a URL-friendly slug.
 *
 * Handles unicode by normalizing to NFD and stripping diacritics,
 * so "café" becomes "cafe", "naïve" becomes "naive", etc.
 */
/**
 * Decode a URI-encoded slug parameter.
 *
 * Browsers percent-encode non-ASCII characters in URLs, so a slug like
 * "మేష-రాసి" arrives as "%e0%b0%ae%e0%b1%87%e0%b0%b7-%e0%b0%b0%e0%b0%be%e0%b0%b8%e0%b0%bf".
 * Call this on `Astro.params.slug` before using it in database lookups.
 */
export function decodeSlug(raw: string | undefined): string | undefined {
	return raw ? decodeURIComponent(raw) : undefined;
}

export function slugify(text: string, maxLength: number = 80): string {
	return (
		text
			.toLowerCase()
			.normalize("NFD")
			.replace(DIACRITICS_PATTERN, "")
			.replace(WHITESPACE_UNDERSCORE_PATTERN, "-")
			.replace(NON_ALPHANUMERIC_HYPHEN_PATTERN, "")
			.replace(MULTIPLE_HYPHENS_PATTERN, "-")
			.replace(LEADING_TRAILING_HYPHEN_PATTERN, "")
			.slice(0, maxLength)
			// Clean trailing hyphen from truncation
			.replace(TRAILING_HYPHEN_PATTERN, "")
	);
}
