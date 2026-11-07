import type { RevisionAuthor, RevisionListItem, RevisionListResponse } from "./api";

export interface AutosavedDraft {
	/** The draft revision the autosave wrote. */
	draft: RevisionListItem;
	/** The entry's draft revision before the autosave. */
	previousDraftId: string | null;
	liveRevisionId: string | null;
	/** How many revisions the cached list asked for. */
	limit: number;
}

/**
 * The revision list as it most likely stands after an autosave, without reading it again: the new
 * draft revision on top, naming its own editors and then those of the draft it follows, which is
 * removed unless that one is also the live revision. The server removes that draft only when it was
 * an autosave too, so the list is read again afterwards to correct the guess.
 */
export function withAutosavedDraft(
	list: RevisionListResponse,
	{ draft, previousDraftId, liveRevisionId, limit }: AutosavedDraft,
): RevisionListResponse {
	const replacesPrevious = previousDraftId !== null && previousDraftId !== liveRevisionId;
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
