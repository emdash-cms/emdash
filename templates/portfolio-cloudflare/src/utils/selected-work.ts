import { getEmDashCollection } from "emdash";

/**
 * The projects marked Feature on home page, newest first, or the six newest
 * when none are. Both queries are request-cached, so the page and the
 * Selected work block share them.
 */
export async function getSelectedWork() {
	const featured = await getEmDashCollection("projects", {
		// Booleans are stored as 0/1 and `where` values are strings
		where: { featured: "1" },
		orderBy: { published_at: "desc" },
		limit: 12,
	});
	if (featured.error || featured.entries.length > 0) return featured;
	return getEmDashCollection("projects", {
		orderBy: { published_at: "desc" },
		limit: 6,
	});
}
