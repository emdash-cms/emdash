/**
 * The title to show for a content entry. Uses the collection's `titleField`
 * if set and non-empty, otherwise falls back to `title → name → slug → id`.
 * Shared so every surface (list, picker, editor) shows the same title.
 */
export function getEntryTitle(
	item: { data: Record<string, unknown>; slug: string | null; id: string },
	titleField?: string,
): string {
	const preferred = titleField ? item.data[titleField] : undefined;
	const rawTitle = item.data.title;
	const rawName = item.data.name;
	return (
		(typeof preferred === "string" ? preferred : "") ||
		(typeof rawTitle === "string" ? rawTitle : "") ||
		(typeof rawName === "string" ? rawName : "") ||
		item.slug ||
		item.id
	);
}

/**
 * The page title `getSeoMeta()` falls back to when an entry has no SEO title:
 * the collection's `titleField` if set and non-empty, otherwise `title`.
 */
export function getSeoFallbackTitle(
	data: Record<string, unknown>,
	titleField?: string,
): string | null {
	const preferred = titleField ? data[titleField] : undefined;
	if (typeof preferred === "string" && preferred) return preferred;
	return typeof data.title === "string" ? data.title : null;
}
