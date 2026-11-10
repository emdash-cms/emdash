/**
 * The lists a save can be based on: an entry's bylines and its reference selections, compared
 * the way the admin reads them, so a client that rebased a change on one read can tell whether
 * the entry still holds that list.
 */

import type { Kysely } from "kysely";

import { BylineRepository, type ContentBylineInput } from "../database/repositories/byline.js";
import type { Database } from "../database/types.js";
import { REFERENCE_PAGE_MAX_LIMIT } from "../references/staged.js";
import { handleReferenceChildrenGet, handleReferenceParentsGet } from "./handlers/relations.js";
import {
	referenceFieldConstraints,
	type ReferenceFieldConstraints,
} from "./handlers/validate-references.js";

/** The lists a save was based on, as a read of the entry returned them. */
export interface ListPreconditions {
	bylines?: ContentBylineInput[];
	/** Every page of each reference field, by field slug. */
	references?: Record<string, string[]>;
}

/** A selection holds at most 1,000 entries, so a read never needs more pages than this. */
const MAX_REFERENCE_PAGES = 11;

export const LIST_CONFLICT_MESSAGE =
	"A list this save was based on changed. Read the entry again and apply the change to it.";

/** Whether every list in `expected` still matches the entry. */
export async function listsMatch(
	db: Kysely<Database>,
	collection: string,
	entry: { id: string; locale: string | null },
	expected: ListPreconditions,
): Promise<boolean> {
	if (expected.bylines) {
		const credits = await new BylineRepository(db).getContentBylines(
			collection,
			entry.id,
			entry.locale ? { locale: entry.locale } : undefined,
		);
		const stored = credits.map((credit) => ({
			bylineId: credit.byline.id,
			roleLabel: credit.roleLabel ?? null,
		}));
		const wanted = expected.bylines.map((credit) => ({
			bylineId: credit.bylineId,
			roleLabel: credit.roleLabel ?? null,
		}));
		if (JSON.stringify(stored) !== JSON.stringify(wanted)) return false;
	}
	if (expected.references) {
		const fields = await referenceFieldConstraints(db, collection);
		for (const [slug, wanted] of Object.entries(expected.references)) {
			const field = fields.get(slug);
			// The write rejects a field that isn't a bound reference field, with a clearer error.
			if (!field) continue;
			// oxlint-disable-next-line no-await-in-loop -- few fields, each read in pages
			const stored = await referenceIds(db, collection, entry.id, field);
			if (!stored || !sameSelection(stored, wanted, field.relationSide === "child")) {
				return false;
			}
		}
	}
	return true;
}

/** The entries a reference field selects, as the admin reads them, or null if it can't tell. */
async function referenceIds(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	field: ReferenceFieldConstraints,
): Promise<string[] | null> {
	const ids: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_REFERENCE_PAGES; page++) {
		const options = { limit: REFERENCE_PAGE_MAX_LIMIT, cursor };
		const result =
			field.relationSide === "child"
				? // oxlint-disable-next-line no-await-in-loop -- each page's cursor comes from the one before
					await handleReferenceParentsGet(db, collection, entryId, field.relation, options, true)
				: // oxlint-disable-next-line no-await-in-loop -- each page's cursor comes from the one before
					await handleReferenceChildrenGet(db, collection, entryId, field.relation, options, true);
		if (!result.success) return null;
		const entries = "parents" in result.data ? result.data.parents : result.data.children;
		for (const entry of entries) ids.push(entry.id);
		cursor = result.data.nextCursor;
		if (!cursor) return ids;
	}
	return null;
}

/** The child end of a relation keeps no order, so only its members count. */
function sameSelection(stored: string[], wanted: string[], unordered: boolean): boolean {
	if (stored.length !== wanted.length) return false;
	const [a, b] = unordered ? [stored.toSorted(), wanted.toSorted()] : [stored, wanted];
	return a.every((id, index) => id === b[index]);
}
