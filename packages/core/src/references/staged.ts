/**
 * The shape a pending reference selection takes inside a draft revision, and how
 * to read and page it.
 *
 * Nothing here touches the database, which is what lets both the write side
 * (`api/handlers/staged-references.ts`, which promotes and validates a staged
 * selection) and the read side (the entry read, the edge routes, the public
 * query resolver) share it without importing each other.
 */

import {
	decodeCursor,
	encodeCursor,
	STAGED_CURSOR_MARKER,
} from "../database/repositories/types.js";

/**
 * Where a collection that keeps drafts stages a pending reference selection: in
 * the draft revision's data, beside `_slug`. The leading underscore is what
 * keeps it out of the column writer, the loaded entry's `data`, and the publish
 * promotion loop, all of which already skip `_`-prefixed keys.
 *
 * The link table holds the live selection only.
 */
export const STAGED_REFERENCES_KEY = "_references";

/**
 * A staged selection, by field slug, holding `translation_group` values rather
 * than entry ids: an edge names a thing, not one locale's row of it, so the
 * group is what the link table stores and what survives an entry being
 * translated or re-slugged between saving and publishing. The save resolves ids
 * to groups so publication has nothing left that can fail to resolve.
 *
 * Order is significant on the parent side, where it becomes `sort_order`.
 */
export type StagedReferences = Record<string, string[]>;

/** Default page size for one reference field, matching the list endpoints. */
export const REFERENCE_PAGE_LIMIT = 50;
/** Hard ceiling, matching the list endpoints. */
export const REFERENCE_PAGE_MAX_LIMIT = 100;

/** One field's page of translation groups, before the entries are loaded. */
export interface PageOfGroups {
	groups: string[];
	nextCursor?: string;
}

/**
 * Page a staged selection, which is a list in memory rather than a table.
 *
 * The cursor anchors on the last group of the previous page rather than on its
 * index: the editor can reorder or drop entries between one page and the next,
 * and an index would then silently skip or repeat. An anchor that is no longer
 * in the selection means the entries it pointed past are gone, so the walk ends.
 */
export function pageStagedGroups(
	groups: string[],
	options: { limit?: number; cursor?: string } = {},
): PageOfGroups {
	const limit = Math.min(
		Math.max(options.limit ?? REFERENCE_PAGE_LIMIT, 1),
		REFERENCE_PAGE_MAX_LIMIT,
	);

	let start = 0;
	if (options.cursor) {
		const decoded = decodeCursor(options.cursor);
		// A cursor from the link table anchors on an edge row id, which is not a
		// group and would match nothing. That happens when a preview session opens
		// mid-pagination over the published selection, so restart the field rather
		// than handing back an empty page that reads as "no more".
		if (decoded.orderValue === STAGED_CURSOR_MARKER) {
			const index = groups.indexOf(decoded.id);
			if (index === -1) return { groups: [] };
			start = index + 1;
		}
	}

	const page = groups.slice(start, start + limit);
	const last = page.at(-1);
	const nextCursor =
		last && start + page.length < groups.length
			? encodeCursor(STAGED_CURSOR_MARKER, last)
			: undefined;
	return { groups: page, nextCursor };
}

function isGroupList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** The staged selection inside a revision's data, if it carries one. */
export function readStagedReferences(
	data: Record<string, unknown> | undefined,
): StagedReferences | undefined {
	const staged = data?.[STAGED_REFERENCES_KEY];
	if (typeof staged !== "object" || staged === null || Array.isArray(staged)) return undefined;

	const result: StagedReferences = {};
	for (const [fieldSlug, groups] of Object.entries(staged)) {
		if (isGroupList(groups)) result[fieldSlug] = groups;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Fold a save's selections into whatever the previous draft staged. A save that
 * names one reference field must not drop another field's pending selection, so
 * fields absent from `incoming` keep their staged value.
 */
export function mergeStagedReferences(
	base: Record<string, unknown> | undefined,
	incoming: StagedReferences,
): StagedReferences {
	return { ...readStagedReferences(base), ...incoming };
}
