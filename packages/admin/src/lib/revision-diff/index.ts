import { describeChanges } from "./changes.js";
import { createDiffContext } from "./context.js";
import { diffFields, diffSlug } from "./fields.js";
import { findRestoredSource } from "./fingerprint.js";
import type {
	DiffFieldDescriptor,
	DiffOptions,
	RevisionData,
	RevisionDiff,
	RevisionLike,
	VersionDiffInput,
} from "./types.js";

export type * from "./types.js";

export { makeSnippet } from "./changes.js";
export { findRestoredSource, restoresNothing } from "./fingerprint.js";

/** EmDash prunes revisions beyond this many per entry, so a full list may be missing the first. */
const KEPT_REVISIONS = 50;

/** Compares two revisions' data for the given fields. `previous` is null for a first version. */
export function diffRevisions(
	previous: RevisionData | null,
	current: RevisionData,
	fields: Readonly<Record<string, DiffFieldDescriptor>>,
	options: DiffOptions = {},
): RevisionDiff {
	const context = createDiffContext(options);
	// A first version compares with itself, so everything reads as unchanged.
	const base = previous ?? current;
	const fieldDiffs = diffFields(base, current, fields, context);
	const slug = diffSlug(base, current);
	return {
		hasPrevious: previous !== null,
		fields: fieldDiffs,
		slug,
		changes: previous
			? describeChanges(fieldDiffs, slug, {
					locale: options.locale,
					titleField: options.titleField,
					restoredFrom: options.restoredFrom ?? null,
				})
			: [{ kind: options.noPrevious ?? "created" }],
	};
}

/**
 * The revisions (newest first) that copy an older loaded one, mapped to the id of the version each
 * restored. The same test `diffVersion` uses to describe a version as restored.
 */
export function restoredSources(
	revisions: readonly RevisionLike[],
	fields: Readonly<Record<string, DiffFieldDescriptor>>,
): Map<string, string> {
	const sources = new Map<string, string>();
	revisions.forEach((revision, index) => {
		const previous = revisions[index + 1] ?? null;
		const source = findRestoredSource(revision, previous, revisions.slice(index + 2), fields);
		if (source) sources.set(revision.id, source);
	});
	return sources;
}

/**
 * Describes `revisions[index]` against the revision before it: picks the previous revision,
 * decides between "created" and "earliest" when there is none, and detects restored copies.
 */
export function diffVersion(input: VersionDiffInput): RevisionDiff {
	const { revisions, index, total, fields } = input;
	const current = revisions[index];
	if (!current) throw new RangeError(`No revision at index ${index}`);
	const previous = revisions[index + 1] ?? null;
	return diffRevisions(previous?.data ?? null, current.data, fields, {
		locale: input.locale,
		titleField: input.titleField,
		noPrevious: revisions.length >= total && total < KEPT_REVISIONS ? "created" : "earliest",
		restoredFrom: findRestoredSource(current, previous, revisions.slice(index + 2), fields),
	});
}
