/**
 * The title to show for a content entry. Uses the collection's `displayField`
 * (#1133) if set and non-empty, otherwise falls back to `title → name → slug → id`.
 * Shared so every surface (list, picker, editor) shows the same title.
 */
export function getEntryTitle(
	item: { data: Record<string, unknown>; slug: string | null; id: string },
	displayField?: string,
): string {
	const preferred = displayField ? item.data[displayField] : undefined;
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
