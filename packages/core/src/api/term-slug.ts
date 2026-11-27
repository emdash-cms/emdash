// Astro recursively decodes route parameters, including percent escapes stored in imported slugs.
const TERM_SLUG_PATTERN =
	/\/_emdash\/api\/taxonomies\/[^/]+\/terms\/([^/]+)(?:\/translations)?\/?$/;

export function getTermSlug(request: Request): string | null {
	const encodedSlug = new URL(request.url).pathname.match(TERM_SLUG_PATTERN)?.[1];
	if (!encodedSlug) return null;
	try {
		return decodeURIComponent(encodedSlug);
	} catch {
		return null;
	}
}
