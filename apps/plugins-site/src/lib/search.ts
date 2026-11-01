import { type PackageSummary, popularKeywords } from "./home.js";

/** Plugins per catalog page: whole rows in the one-, two-, and three-column grids. */
export const PAGE_SIZE = 48;

const PAGE_NUMBER = /^[1-9]\d*$/;

/** The muted second line of the search heading. */
export function resultSummary(query: string, count: number): string {
	if (!query) return `${count} in the registry`;
	if (count === 0) return "No matches";
	return count === 1 ? "1 plugin" : `${count} plugins`;
}

/** Keyword links to refine a search, leaving out the query itself. */
export function refineKeywords(packages: readonly PackageSummary[], query: string): string[] {
	const current = query.trim().toLowerCase();
	return popularKeywords(packages, 7)
		.filter((keyword) => keyword !== current)
		.slice(0, 6);
}

/** The page a `page` search parameter asks for: 1 when it's absent, undefined when it isn't a page number. */
export function parsePage(value: string | null): number | undefined {
	if (value === null) return 1;
	return PAGE_NUMBER.test(value) ? Number(value) : undefined;
}

/** A catalog URL. The first page has no `page` parameter, so each page has one address. */
export function searchHref(query: string, page = 1): string {
	const params = [
		...(query ? [`q=${encodeURIComponent(query)}`] : []),
		...(page > 1 ? [`page=${page}`] : []),
	];
	return params.length > 0 ? `/search?${params.join("&")}` : "/search";
}

/**
 * The page numbers to link: the first and last pages, the current page and its
 * neighbours, and a gap for each run of pages left out. Past seven pages there
 * are always seven items, so the links keep their places from page to page.
 */
export function pageLinks(current: number, count: number): (number | "gap")[] {
	if (count <= 7) return pageRange(1, count);
	const start = Math.max(Math.min(current - 1, count - 4), 3);
	const end = Math.min(Math.max(current + 1, 5), count - 2);
	return [
		1,
		start > 3 ? "gap" : 2,
		...pageRange(start, end),
		end < count - 2 ? "gap" : count - 1,
		count,
	];
}

function pageRange(start: number, end: number): number[] {
	return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
