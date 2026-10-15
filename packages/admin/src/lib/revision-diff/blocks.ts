import { alignBlocks } from "./align.js";
import type { DiffContext } from "./context.js";
import { blockSignature, imageLayoutKey } from "./normalize.js";
import { diffText, plainRuns } from "./text-diff.js";
import { tokenizeCode, tokenizeWords } from "./tokens.js";
import type { BlockChange, BlockRow, NormalizedBlock } from "./types.js";

/**
 * Rows of a Portable Text field in document order. A removed block sits right after the new
 * position of the old block before it; a moved block shows only in its new place.
 */
export function diffBlocks(
	oldBlocks: readonly NormalizedBlock[],
	newBlocks: readonly NormalizedBlock[],
	slug: string,
	context: DiffContext,
): BlockRow[] {
	const { pairs, moved } = alignBlocks(oldBlocks, newBlocks, context);
	const oldIndexOf = new Map<number, number>();
	const removedAfter = new Map<number, number[]>();
	let anchor = -1;
	oldBlocks.forEach((_, o) => {
		const n = pairs.get(o);
		if (n !== undefined) {
			oldIndexOf.set(n, o);
			if (!moved.has(o)) anchor = n;
			return;
		}
		const removed = removedAfter.get(anchor);
		if (removed) removed.push(o);
		else removedAfter.set(anchor, [o]);
	});

	const rows: BlockRow[] = [];
	const targetId = () => `b-${slug}-${rows.length}`;
	const addRemoved = (anchorIndex: number) => {
		for (const o of removedAfter.get(anchorIndex) ?? []) {
			const block = oldBlocks[o];
			if (block) rows.push({ status: "removed", targetId: targetId(), block });
		}
	};

	addRemoved(-1);
	newBlocks.forEach((block, n) => {
		const o = oldIndexOf.get(n);
		const previous = o === undefined ? undefined : oldBlocks[o];
		if (o === undefined || !previous) {
			rows.push({ status: "added", targetId: targetId(), block });
		} else {
			rows.push(compareBlocks(previous, block, moved.has(o), targetId(), context));
		}
		addRemoved(n);
	});
	return rows;
}

function compareBlocks(
	previous: NormalizedBlock,
	block: NormalizedBlock,
	moved: boolean,
	targetId: string,
	context: DiffContext,
): BlockRow {
	if (blockSignature(previous) === blockSignature(block)) {
		return { status: "unchanged", targetId, block, moved };
	}
	return {
		status: "changed",
		targetId,
		block,
		previous,
		change: blockChange(previous, block, context),
	};
}

function blockChange(
	previous: NormalizedBlock,
	block: NormalizedBlock,
	context: DiffContext,
): BlockChange {
	const words = (text: string) => tokenizeWords(text, context.locale);
	if (previous.kind === "text" && block.kind === "text") {
		return {
			kind: "text",
			text: diffText(previous.runs, block.runs, words, context),
			styleChanged:
				previous.style !== block.style ||
				previous.listItem !== block.listItem ||
				previous.level !== block.level ||
				previous.listStart !== block.listStart ||
				previous.textAlign !== block.textAlign,
		};
	}
	if (previous.kind === "image" && block.kind === "image") {
		return {
			kind: "image",
			assetChanged: previous.asset !== block.asset,
			altChanged: previous.alt !== block.alt,
			captionChanged: previous.caption !== block.caption,
			otherChanged: imageLayoutKey(previous) !== imageLayoutKey(block),
			caption: diffText(plainRuns(previous.caption), plainRuns(block.caption), words, context),
		};
	}
	if (previous.kind === "code" && block.kind === "code") {
		return {
			kind: "code",
			code: diffText(plainRuns(previous.code), plainRuns(block.code), tokenizeCode, context),
		};
	}
	return { kind: "opaque" };
}
