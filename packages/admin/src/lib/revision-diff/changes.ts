import { blockNoun } from "./normalize.js";
import { wordSegmenter } from "./tokens.js";
import type {
	BlockChange,
	BlockRow,
	ChangeItem,
	FieldDiff,
	FieldRef,
	ItemRow,
	NormalizedBlock,
	RevisionDiff,
	Snippet,
} from "./types.js";

const WHITESPACE_RUN = /\s+/gu;
const WHITESPACE = /\s/u;
// The UI wraps snippets in its own quotation marks.
const EDGE_QUOTES = /^[\s"'“”‘’„‚«»‹›「」『』〝〞〟＂＇]+|[\s"'“”‘’„‚«»‹›「」『』〝〞〟＂＇]+$/gu;
// Closing brackets (Pe) stay, so a truncated "(see below)" keeps its parenthesis.
const TRAILING_PUNCTUATION = /[\s\p{Po}\p{Pd}\p{Ps}\p{Pi}\p{Pf}\p{Pc}]+$/u;

// Scripts written without spaces between words, which get a character budget instead of words.
const UNSPACED_SCRIPT =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const MAX_SPACED_WORDS = 5;
const MAX_SPACED_LENGTH = 40;
const MAX_UNSPACED_LENGTH = 16;

const TEXT_CHANGES = { added: "added", removed: "removed", changed: "edited" } as const;

interface DescribeOptions {
	locale: string | undefined;
	titleField: string | undefined;
	restoredFrom: string | null;
}

/** What changed, in field order and then the slug; `noChanges` only when nothing did. */
export function describeChanges(
	fields: readonly FieldDiff[],
	slug: RevisionDiff["slug"],
	options: DescribeOptions,
): ChangeItem[] {
	const items: ChangeItem[] = [];
	for (const field of fields) {
		const ref: FieldRef = { slug: field.slug, label: field.label };
		if (field.type === "portableText") {
			for (const row of field.rows) {
				const item = blockItem(ref, row, options.locale);
				if (item) items.push(item);
			}
			continue;
		}
		if (field.type === "items") {
			for (const row of field.rows) {
				items.push(
					...(field.kind === "blocks"
						? blockItemEntries(ref, row)
						: repeaterItemEntries(ref, row, null)),
				);
			}
			continue;
		}
		if (field.status === "unchanged") continue;
		const target = field.targetId;
		if (field.slug === options.titleField) {
			items.push({ kind: "title", field: ref, target });
		} else if (field.type === "text") {
			items.push({ kind: "text", field: ref, change: TEXT_CHANGES[field.status], target });
		} else if (field.type === "boolean") {
			items.push({ kind: "toggle", field: ref, on: field.after, target });
		} else {
			items.push({ kind: "field", field: ref, target });
		}
	}
	if (slug && slug.status !== "unchanged") {
		items.push({ kind: "slug", after: slug.after });
	}
	if (options.restoredFrom) items.unshift({ kind: "restored", revisionId: options.restoredFrom });
	return items.length > 0 ? items : [{ kind: "noChanges" }];
}

function blockItem(field: FieldRef, row: BlockRow, locale: string | undefined): ChangeItem | null {
	const target = row.targetId;
	switch (row.status) {
		case "unchanged":
			return row.moved ? blockEntry(field, row.block, "moved", target, locale) : null;
		case "added":
		case "removed":
			if (row.block.kind === "text" && !row.block.text.trim()) return null;
			if (row.block.kind === "image") return { kind: "image", field, action: row.status, target };
			return blockEntry(field, row.block, row.status, target, locale);
		case "changed": {
			const { change } = row;
			if (change.kind === "image") {
				return { kind: "image", field, action: imageAction(change), target };
			}
			const action = change.kind === "text" && !change.text.textChanged ? "restyled" : "edited";
			const item = blockEntry(field, row.block, action, target, locale);
			// A block whose text was cleared is still named by what it used to say.
			return item.snippet ? item : { ...item, snippet: snippetOf(row.previous, locale) };
		}
	}
}

/** An entry for an added, removed or moved block, and one for each field an edit changed. */
function blockItemEntries(field: FieldRef, row: ItemRow): ChangeItem[] {
	const entry = (
		action: Extract<ChangeItem, { kind: "blockItem" }>["action"],
		target = row.targetId,
		blockField: FieldRef | null = null,
	): ChangeItem => ({
		kind: "blockItem",
		field,
		action,
		label: row.label ?? row.type,
		blockField,
		target,
	});
	if (row.status === "added" || row.status === "removed") return [entry(row.status)];
	const entries = row.moved ? [entry("moved")] : [];
	if (row.status === "changed") {
		for (const changed of row.fields) {
			if (changed.status === "unchanged") continue;
			const blockField = { slug: changed.slug, label: changed.label };
			const inner =
				changed.type === "items"
					? changed.rows.flatMap((innerRow) =>
							repeaterItemEntries(blockField, innerRow, row.label ?? row.type),
						)
					: [];
			if (inner.length > 0) entries.push(...inner);
			else entries.push(entry("edited", changed.targetId, blockField));
		}
	}
	return entries;
}

/** An entry for an added, removed or moved repeater item, and one for each field an edit changed. */
function repeaterItemEntries(field: FieldRef, row: ItemRow, block: string | null): ChangeItem[] {
	const entry = (
		action: Extract<ChangeItem, { kind: "repeaterItem" }>["action"],
		target = row.targetId,
		itemField: FieldRef | null = null,
	): ChangeItem => ({
		kind: "repeaterItem",
		field,
		action,
		position: row.position,
		itemField,
		block,
		target,
	});
	if (row.status === "added" || row.status === "removed") return [entry(row.status)];
	const entries = row.moved ? [entry("moved")] : [];
	if (row.status === "changed") {
		for (const changed of row.fields) {
			if (changed.status === "unchanged") continue;
			entries.push(entry("edited", changed.targetId, { slug: changed.slug, label: changed.label }));
		}
	}
	return entries;
}

/** Names the one thing that changed about an image, or calls it changed when several did. */
function imageAction(
	change: Extract<BlockChange, { kind: "image" }>,
): Extract<ChangeItem, { kind: "image" }>["action"] {
	if (change.assetChanged) return "replaced";
	const { captionChanged, altChanged, otherChanged } = change;
	if (captionChanged && !altChanged && !otherChanged) return "captionEdited";
	if (altChanged && !captionChanged && !otherChanged) return "altEdited";
	return "changed";
}

function blockEntry(
	field: FieldRef,
	block: NormalizedBlock,
	action: "added" | "removed" | "edited" | "restyled" | "moved",
	target: string,
	locale: string | undefined,
): Extract<ChangeItem, { kind: "block" }> {
	return {
		kind: "block",
		field,
		action,
		noun: blockNoun(block),
		snippet: snippetOf(block, locale),
		target,
	};
}

function snippetOf(block: NormalizedBlock, locale: string | undefined): Snippet | null {
	return block.kind === "text" ? makeSnippet(block.text, locale) : null;
}

/**
 * The opening words of a block, for naming it in a change list: up to five words, or a few
 * characters in scripts written without spaces. Surrounding quotation marks are dropped, and a
 * truncated snippet loses its trailing punctuation so the UI can add an ellipsis.
 */
export function makeSnippet(text: string, locale?: string): Snippet | null {
	const clean = text.replace(WHITESPACE_RUN, " ").replace(EDGE_QUOTES, "");
	if (!clean) return null;
	const spaced = WHITESPACE.test(clean) || !UNSPACED_SCRIPT.test(clean);
	let snippet = "";
	let words = 0;
	for (const { segment, isWordLike } of wordSegmenter(locale).segment(clean)) {
		if (isWordLike && words > 0) {
			const full = spaced
				? words >= MAX_SPACED_WORDS || snippet.length + segment.length > MAX_SPACED_LENGTH
				: snippet.length + segment.length > MAX_UNSPACED_LENGTH;
			if (full) return { text: snippet.replace(TRAILING_PUNCTUATION, ""), truncated: true };
		}
		if (isWordLike) words++;
		snippet += segment;
	}
	return { text: clean, truncated: false };
}
