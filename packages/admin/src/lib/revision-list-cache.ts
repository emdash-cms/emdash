import type { QueryClient } from "@tanstack/react-query";

import type { RevisionAuthor, RevisionListItem, RevisionListResponse } from "./api";

const autosavedDrafts = new WeakMap<QueryClient, Map<string, string>>();

/**
 * The draft revision this client's latest autosave of each entry wrote, keyed by
 * {@link autosavedDraftKey}.
 */
export function lastAutosavedDrafts(queryClient: QueryClient): Map<string, string> {
	let drafts = autosavedDrafts.get(queryClient);
	if (!drafts) {
		drafts = new Map();
		autosavedDrafts.set(queryClient, drafts);
	}
	return drafts;
}

export function autosavedDraftKey(collection: string, entryId: string): string {
	return JSON.stringify([collection, entryId]);
}

export interface AutosavedDraft {
	/** The draft revision the autosave wrote. */
	draft: RevisionListItem;
	/** The entry's draft revision before the autosave. */
	previousDraftId: string | null;
	/** Whether this client's own autosave wrote `previousDraftId`. */
	previousIsAutosave: boolean;
	liveRevisionId: string | null;
	/** How many revisions the cached list asked for. */
	limit: number;
}

/**
 * The revision list as it most likely stands after an autosave, without reading it again: the new
 * draft revision on top. The server replaces the draft it follows only when that one was an
 * autosave, so it's removed, and its editors named after the new draft's, only when this client's
 * own autosave wrote it and it isn't the live revision. The list is read again afterwards to
 * correct the guess.
 */
export function withAutosavedDraft(
	list: RevisionListResponse,
	{ draft, previousDraftId, previousIsAutosave, liveRevisionId, limit }: AutosavedDraft,
): RevisionListResponse {
	const replacesPrevious =
		previousIsAutosave && previousDraftId !== null && previousDraftId !== liveRevisionId;
	const previous = replacesPrevious
		? list.items.find((item) => item.id === previousDraftId)
		: undefined;
	const alreadyListed = list.items.some((item) => item.id === draft.id);
	const kept = list.items.filter((item) => item.id !== draft.id && item !== previous);
	const total = list.total + (alreadyListed ? 0 : 1) - (previous ? 1 : 0);
	const next = previous ? { ...draft, editedBy: carriedEditors(draft, previous) } : draft;
	return { items: [next, ...kept].slice(0, limit), total };
}

/** Everyone a revision names, as the server records them: its editors, or else its author. */
function editors(item: RevisionListItem): Array<RevisionAuthor | null> {
	return item.editedBy ?? (item.authorId ? [item.author] : []);
}

/** The autosave's editors, then those of the autosave it replaces, each person once. */
function carriedEditors(
	draft: RevisionListItem,
	previous: RevisionListItem,
): Array<RevisionAuthor | null> {
	const seen = new Set<string>();
	const names: Array<RevisionAuthor | null> = [];
	for (const person of [...editors(draft), ...editors(previous)]) {
		if (person) {
			if (seen.has(person.id)) continue;
			seen.add(person.id);
		}
		names.push(person);
	}
	return names;
}
