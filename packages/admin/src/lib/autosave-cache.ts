import type { QueryClient } from "@tanstack/react-query";

import type { ContentItem, Revision } from "./api";

/*
 * The content query stores the merged edit item as { slug, data }, but the
 * draft revision query stores fields directly in revision.data with the draft
 * slug under _slug. Rebuild that revision payload shape before updating it.
 */
function buildDraftRevisionData(item: Pick<ContentItem, "data" | "slug">): Record<string, unknown> {
	return {
		...item.data,
		_slug: item.slug,
	};
}

/*
 * Apply a saved item to the edit page's two related queries:
 * - ["content", collection, id] keeps the item's metadata and merged field data
 * - ["revision", draftRevisionId] holds the draft working copy when one is loaded
 */
export function applyAutosaveResultToQueryCache(
	queryClient: QueryClient,
	collection: string,
	id: string,
	savedItem: ContentItem,
): void {
	queryClient.setQueryData(["content", collection, id], savedItem);

	if (!savedItem.draftRevisionId) {
		return;
	}

	const draftRevisionQueryKey = ["revision", savedItem.draftRevisionId] as const;
	const existingDraftRevision = queryClient.getQueryData<Revision>(draftRevisionQueryKey);

	if (!existingDraftRevision) {
		return;
	}

	queryClient.setQueryData<Revision>(draftRevisionQueryKey, {
		...existingDraftRevision,
		data: buildDraftRevisionData(savedItem),
	});
}
