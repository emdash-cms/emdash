/**
 * The merge rule and the merge base updates, as pure functions over hashes and values. Keys are
 * field slugs, and `slug` for the entry slug.
 */

import { ENTRY_SLUG } from "@emdash-cms/admin/internal/co-editing";

import type { ContentWrite } from "../api/content-save.js";
import { hashValue } from "./hash.js";
import type { CheckpointInput, MergeBase } from "./types.js";

export type FieldDecision = "none" | "write" | "keep-document" | "start-over";

export interface FieldChanges {
	/** The stored value's hash differs from the merge base's stored hash. */
	storedChanged: boolean;
	/** See {@link isDocumentChanged}. */
	documentChanged: boolean;
	/** The stored value and the document's value differ. */
	valuesDiffer: boolean;
	open: boolean;
}

/**
 * What a merge does with one value. Where both sides changed it, the document keeps its value
 * and the next save sends it, except that a room that isn't open, whose uncovered updates may be
 * an hour old, starts over when the two values differ.
 */
export function decideField({
	storedChanged,
	documentChanged,
	valuesDiffer,
	open,
}: FieldChanges): FieldDecision {
	if (!storedChanged) return "none";
	if (!documentChanged) return "write";
	return !open && valuesDiffer ? "start-over" : "keep-document";
}

/**
 * Whether the document changed a value since the merge base: its document hash was cleared, or
 * an update touched it since the last checkpoint and it now serializes to another hash.
 */
export function isDocumentChanged(
	baseHash: string | null | undefined,
	pending: boolean,
	currentHash: string,
): boolean {
	return baseHash === null || (pending && currentHash !== baseHash);
}

/** The hash of each value, under the same key. */
export function hashValues(values: Record<string, unknown>): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) hashes[key] = hashValue(value);
	return hashes;
}

/**
 * The merge base of a new document. Document hashes come from the new document as it
 * serializes, never from the stored values, or a value whose round trip isn't byte-identical
 * would look changed.
 */
export function initialMergeBase(
	rev: string,
	stored: Record<string, unknown>,
	document: Record<string, unknown>,
): MergeBase {
	return { rev, stored: hashValues(stored), document: hashValues(document) };
}

/**
 * The merge base after a save, from the save's own write and never from a later read: `rev` and
 * each value's stored hash from the write, and each sent value's document hash from what was
 * sent. The slug's stored and document hashes both come from the slug sent, if any, and
 * otherwise stay.
 */
export function mergeBaseAfterSave(
	base: MergeBase,
	sent: Pick<CheckpointInput, "data" | "slug">,
	write: Pick<ContentWrite, "rev" | "data">,
): MergeBase {
	const stored: Record<string, string> = { ...base.stored };
	for (const key of Object.keys(stored)) {
		if (key !== ENTRY_SLUG.slug) {
			stored[key] = hashValue(Object.hasOwn(write.data, key) ? write.data[key] : undefined);
		}
	}
	const document: Record<string, string | null> = { ...base.document, ...hashValues(sent.data) };
	if (sent.slug !== undefined) {
		const slug = hashValue(sent.slug);
		stored[ENTRY_SLUG.slug] = slug;
		document[ENTRY_SLUG.slug] = slug;
	}
	return { rev: write.rev, stored, document };
}

/**
 * The merge base after a merge: `rev` and every stored hash from the loaded entry, each written
 * value's document hash as it serializes after the write, and no document hash for each value
 * the document kept, so the next save sends it.
 */
export function mergeBaseAfterMerge(
	base: MergeBase,
	merge: {
		rev: string;
		stored: Record<string, string>;
		written: Record<string, string>;
		kept: Iterable<string>;
	},
): MergeBase {
	const document: Record<string, string | null> = { ...base.document, ...merge.written };
	for (const key of merge.kept) document[key] = null;
	return { rev: merge.rev, stored: { ...merge.stored }, document };
}
