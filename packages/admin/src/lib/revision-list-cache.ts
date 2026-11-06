import type { RevisionListItem, RevisionListResponse } from "./api";

export interface AutosavedDraft {
	/** The draft revision the autosave wrote. */
	draft: RevisionListItem;
	/** The entry's draft revision before the autosave. */
	previousDraftId: string | null;
	liveRevisionId: string | null;
	/** How many revisions the cached list asked for. */
	limit: number;
	/** Set when the autosave kept the draft it replaced, as a manual save does. */
	keepPrevious?: boolean;
}

/**
 * The revision list as it stands after an autosave, without reading it again. An autosave writes
 * a new draft revision and deletes the one it replaces, unless that one is also the live revision
 * or the autosave kept it.
 */
export function withAutosavedDraft(
	list: RevisionListResponse,
	{ draft, previousDraftId, liveRevisionId, limit, keepPrevious = false }: AutosavedDraft,
): RevisionListResponse {
	const replacesPrevious =
		!keepPrevious && previousDraftId !== null && previousDraftId !== liveRevisionId;
	const removesPrevious =
		replacesPrevious && list.items.some((item) => item.id === previousDraftId);
	const alreadyListed = list.items.some((item) => item.id === draft.id);
	const kept = list.items.filter(
		(item) => item.id !== draft.id && !(removesPrevious && item.id === previousDraftId),
	);
	const total = list.total + (alreadyListed ? 0 : 1) - (removesPrevious ? 1 : 0);
	return { items: [draft, ...kept].slice(0, limit), total };
}
