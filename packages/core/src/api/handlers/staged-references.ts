import type { Kysely } from "kysely";

import { RelationRepository } from "../../database/repositories/relation.js";
import { RevisionRepository } from "../../database/repositories/revision.js";
import type { Database } from "../../database/types.js";
import { STAGED_REFERENCES_KEY, type StagedReferences } from "../../references/staged.js";
import type { ApiResult } from "../types.js";
import { validateOppositeSideLimit, writeReferenceSelection } from "./relations.js";
import {
	referenceFieldConstraints,
	validateReferenceSelection,
	type ReferenceFieldConstraints,
} from "./validate-references.js";

export {
	mergeStagedReferences,
	pageStagedGroups,
	readStagedReferences,
	REFERENCE_PAGE_LIMIT,
	REFERENCE_PAGE_MAX_LIMIT,
	STAGED_REFERENCES_KEY,
} from "../../references/staged.js";
export type { PageOfGroups, StagedReferences } from "../../references/staged.js";

/** One bound field's live selection as translation groups. */
async function liveFieldSelection(
	repo: RelationRepository,
	field: ReferenceFieldConstraints,
	entryGroup: string,
): Promise<string[]> {
	const links =
		field.relationSide === "child"
			? await repo.getParents(field.relation, entryGroup)
			: await repo.getChildren(field.relation, entryGroup);
	return links.map((link) => (field.relationSide === "child" ? link.parentGroup : link.childGroup));
}

/**
 * Re-check what publication is about to make live against the relation's current
 * cardinality.
 *
 * A draft can sit unpublished across a schema edit that makes its field required
 * or narrows the relation's limits, and across another entry claiming what it
 * selected. It is publication — not the save that staged it — that has to hold
 * the line on both ends. So this walks the collection's bound fields rather than
 * the staged keys: a field added as required after the entry was written appears
 * in no existing draft, and iterating `staged` would never reach it. A field the
 * draft does stage needs no link read.
 */
export async function validateStagedReferences(
	db: Kysely<Database>,
	collection: string,
	staged: StagedReferences,
	entryGroup: string,
): Promise<ApiResult<true>> {
	const repo = new RelationRepository(db);
	for (const field of (await referenceFieldConstraints(db, collection)).values()) {
		const isStaged = Object.hasOwn(staged, field.slug);
		const groups = isStaged
			? (staged[field.slug] ?? [])
			: await liveFieldSelection(repo, field, entryGroup);
		const valid = validateReferenceSelection(field, groups);
		if (!valid.success) return valid;

		// Only a staged selection can have gone stale: a live one is already
		// within the limits it was written under.
		if (!isStaged || field.relationId === null) continue;
		const far = await validateOppositeSideLimit(db, {
			relationId: field.relationId,
			farLimit: field.maxOpposite,
			side: field.relationSide,
			entryGroup,
			groups,
		});
		if (!far.success) return far;
	}
	return { success: true, data: true };
}

/**
 * The live selection, in the same shape a draft stages: every bound reference
 * field on the collection, by field slug, as translation groups.
 *
 * One link read per bound field. Used where both selections have to be
 * comparable — the live and draft sides of a compare — never on a render path.
 */
export async function liveReferenceSelection(
	db: Kysely<Database>,
	collection: string,
	entryGroup: string,
): Promise<StagedReferences> {
	const repo = new RelationRepository(db);
	const selection: StagedReferences = {};
	for (const field of (await referenceFieldConstraints(db, collection)).values()) {
		selection[field.slug] = await liveFieldSelection(repo, field, entryGroup);
	}
	return selection;
}

/**
 * Record the complete live selection in the revision publication just made live.
 *
 * A draft stages only the fields its saves named, and a revision written from
 * the columns stages none. Restoring either would otherwise leave whatever was
 * published after it linked in the fields it does not carry.
 */
export async function recordPublishedReferences(
	db: Kysely<Database>,
	collection: string,
	revisionId: string,
	entryGroup: string,
): Promise<void> {
	const selection = await liveReferenceSelection(db, collection, entryGroup);
	if (Object.keys(selection).length === 0) return;
	await new RevisionRepository(db).mergeData(revisionId, { [STAGED_REFERENCES_KEY]: selection });
}

/**
 * Promote a staged selection to live links.
 *
 * A field slug the collection no longer carries as a bound reference field is
 * skipped: the revision outlived the field, and there is no relation left to
 * write into.
 */
export async function applyStagedReferences(
	db: Kysely<Database>,
	collection: string,
	entryGroup: string,
	staged: StagedReferences,
): Promise<void> {
	const constraints = await referenceFieldConstraints(db, collection);
	for (const [fieldSlug, groups] of Object.entries(staged)) {
		const field = constraints.get(fieldSlug);
		if (!field) continue;
		await writeReferenceSelection(db, {
			relation: field.relation,
			side: field.relationSide,
			entryGroup,
			groups,
		});
	}
}
