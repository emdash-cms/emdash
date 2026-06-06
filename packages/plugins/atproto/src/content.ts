/**
 * Shared content helpers for ATProto outputs.
 *
 * These helpers intentionally stay small and boring so standard.site and
 * Bluesky can share path/field lookup behavior without coupling their
 * output-specific formatting logic.
 */

export function getString(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getContentData(content: Record<string, unknown>): Record<string, unknown> {
	return content.data && typeof content.data === "object"
		? (content.data as Record<string, unknown>)
		: {};
}

export function getContentString(
	content: Record<string, unknown>,
	key: string,
): string | undefined {
	return getString(content, key) || getString(getContentData(content), key);
}

export function buildContentPath(
	collection: string | undefined,
	content: Record<string, unknown>,
): string | undefined {
	const slug = getContentString(content, "slug");
	if (!slug) return undefined;

	if (!collection || collection === "pages") return `/${slug}`;
	return `/${collection}/${slug}`;
}
