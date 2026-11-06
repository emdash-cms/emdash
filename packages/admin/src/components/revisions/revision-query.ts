import { queryOptions } from "@tanstack/react-query";

import { fetchRevisions, type RevisionListResponse } from "../../lib/api";

/** The list shows 20 versions and loads one more, so the oldest one shown has something to compare with. */
export const REVISION_LIST_LIMIT = 21;
/** Enough for every revision the server keeps (50 per entry, plus the live and draft ones). */
export const REVISION_LIST_LIMIT_ALL = 100;

export function revisionsQueryOptions(collection: string, entryId: string, limit: number) {
	return queryOptions({
		queryKey: ["revisions", collection, entryId, { limit }] as const,
		queryFn: ({ signal }) => fetchRevisions(collection, entryId, { limit, signal }),
		// Keeps the shorter list on screen while "Show older versions" loads, but never shows
		// another entry's versions.
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === collection && previousQuery.queryKey[2] === entryId
				? previous
				: undefined,
	});
}

/** How many of the loaded revisions to show: all of them unless one was loaded only for comparison. */
export function visibleRevisionCount(list: RevisionListResponse): number {
	return list.items.length < list.total ? Math.max(0, list.items.length - 1) : list.items.length;
}
