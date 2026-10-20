import { type PackageSummary, popularKeywords } from "./home.js";

/** The catalog asks the registry for at most this many plugins. */
export const SEARCH_LIMIT = 100;

/** The muted second line of the search heading. */
export function resultSummary(query: string, count: number): string {
	const total = count >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : String(count);
	if (!query) return `${total} in the registry`;
	if (count === 0) return "No matches";
	return count === 1 ? "1 plugin" : `${total} plugins`;
}

/** Keyword links to refine a search, leaving out the query itself. */
export function refineKeywords(packages: readonly PackageSummary[], query: string): string[] {
	const current = query.trim().toLowerCase();
	return popularKeywords(packages, 7)
		.filter((keyword) => keyword !== current)
		.slice(0, 6);
}
