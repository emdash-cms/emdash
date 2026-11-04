import type { DiffContext } from "./context.js";
import { createInterner, lcsPairs } from "./lcs.js";
import { EMPTY_MARKS, sameMarks } from "./normalize.js";
import type { Token, Tokenizer } from "./tokens.js";
import type { DiffSegment, TextDiff, TextRun } from "./types.js";

const WHITESPACE = /\s/u;

/** A stretch of the old and new text that is either equal on both sides or replaced. */
interface Hunk {
	changed: boolean;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

/** Equal or differing token ranges, in token indices. */
interface TokenOp {
	same: boolean;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

export function plainRuns(text: string): TextRun[] {
	return text ? [{ text, marks: EMPTY_MARKS }] : [];
}

/** The large-text fallback: the new text as unchanged segments. */
function wholeText(runs: readonly TextRun[]): TextDiff {
	return {
		mode: "whole",
		textChanged: true,
		segments: runs.map((run) => ({
			text: run.text,
			change: "same",
			marks: run.marks,
			hunk: null,
			formatChanged: false,
		})),
	};
}

/**
 * Word diff of two texts that keeps each run's marks: unchanged text carries the new marks,
 * removed text the old ones. Falls back to `whole` mode when the texts are too large to compare.
 */
export function diffText(
	oldRuns: readonly TextRun[],
	newRuns: readonly TextRun[],
	tokenize: Tokenizer,
	context: DiffContext,
): TextDiff {
	const oldText = joinRuns(oldRuns);
	const newText = joinRuns(newRuns);
	const segments: DiffSegment[] = [];

	if (oldText === newText) {
		appendSame(segments, oldRuns, newRuns);
		return { mode: "inline", textChanged: false, segments };
	}

	const hunks = diffHunks(oldText, newText, tokenize(oldText), tokenize(newText), context);
	if (!hunks) return wholeText(newRuns);

	const oldStarts = runStarts(oldRuns);
	const newStarts = runStarts(newRuns);
	for (const hunk of hunks) {
		const oldPart = sliceRuns(oldRuns, oldStarts, hunk.oldStart, hunk.oldEnd);
		const newPart = sliceRuns(newRuns, newStarts, hunk.newStart, hunk.newEnd);
		if (!hunk.changed) {
			appendSame(segments, oldPart, newPart);
			continue;
		}
		const id = context.nextHunk++;
		for (const run of oldPart) {
			appendSegment(segments, { ...run, change: "removed", hunk: id, formatChanged: false });
		}
		for (const run of newPart) {
			appendSegment(segments, { ...run, change: "added", hunk: id, formatChanged: false });
		}
	}
	return { mode: "inline", textChanged: true, segments };
}

function joinRuns(runs: readonly TextRun[]): string {
	return runs.map((run) => run.text).join("");
}

function diffHunks(
	oldText: string,
	newText: string,
	oldTokens: readonly Token[],
	newTokens: readonly Token[],
	context: DiffContext,
): Hunk[] | null {
	const intern = createInterner();
	const a = intern(oldTokens.map((token) => token.text));
	const b = intern(newTokens.map((token) => token.text));

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let oldEnd = a.length;
	let newEnd = b.length;
	while (oldEnd > start && newEnd > start && a[oldEnd - 1] === b[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}

	const cells = (oldEnd - start) * (newEnd - start);
	if (cells > context.limits.maxTokenCellsPerText || cells > context.cellsLeft) return null;
	context.cellsLeft -= cells;

	const matches: Array<[number, number]> = [];
	for (let index = 0; index < start; index++) matches.push([index, index]);
	for (const [i, j] of lcsPairs(a.subarray(start, oldEnd), b.subarray(start, newEnd))) {
		matches.push([start + i, start + j]);
	}
	for (let offset = 0; oldEnd + offset < a.length; offset++) {
		matches.push([oldEnd + offset, newEnd + offset]);
	}

	const ops = tokenOps(matches, a.length, b.length);
	return trimHunks(foldHunks(ops, oldText, newText, oldTokens, newTokens), oldText, newText);
}

function tokenOps(
	matches: ReadonlyArray<readonly [number, number]>,
	oldLength: number,
	newLength: number,
): TokenOp[] {
	const ops: TokenOp[] = [];
	let oldPosition = 0;
	let newPosition = 0;
	for (const [i, j] of matches) {
		if (i > oldPosition || j > newPosition) {
			ops.push({
				same: false,
				oldStart: oldPosition,
				oldEnd: i,
				newStart: newPosition,
				newEnd: j,
			});
		}
		const last = ops.at(-1);
		if (last?.same && last.oldEnd === i && last.newEnd === j) {
			last.oldEnd = i + 1;
			last.newEnd = j + 1;
		} else {
			ops.push({ same: true, oldStart: i, oldEnd: i + 1, newStart: j, newEnd: j + 1 });
		}
		oldPosition = i + 1;
		newPosition = j + 1;
	}
	if (oldPosition < oldLength || newPosition < newLength) {
		ops.push({
			same: false,
			oldStart: oldPosition,
			oldEnd: oldLength,
			newStart: newPosition,
			newEnd: newLength,
		});
	}
	return ops;
}

/**
 * Turns token ops into character hunks. A tiny unchanged stretch between two changes (only
 * spaces and punctuation, or one short word) joins the change around it, so a rewritten phrase
 * reads as one replacement instead of alternating marks word by word.
 */
function foldHunks(
	ops: readonly TokenOp[],
	oldText: string,
	newText: string,
	oldTokens: readonly Token[],
	newTokens: readonly Token[],
): Hunk[] {
	const hunks: Hunk[] = [];
	ops.forEach((op, index) => {
		const range = {
			oldStart: tokenOffset(oldTokens, op.oldStart, oldText),
			oldEnd: tokenOffset(oldTokens, op.oldEnd, oldText),
			newStart: tokenOffset(newTokens, op.newStart, newText),
			newEnd: tokenOffset(newTokens, op.newEnd, newText),
		};
		const last = hunks.at(-1);
		const joinsLast =
			last?.changed === true &&
			(!op.same ||
				(index + 1 < ops.length &&
					isTiny(oldTokens, op, oldText.slice(range.oldStart, range.oldEnd))));
		if (last && joinsLast) {
			last.oldEnd = range.oldEnd;
			last.newEnd = range.newEnd;
		} else {
			hunks.push({ changed: !op.same, ...range });
		}
	});
	return hunks;
}

function tokenOffset(tokens: readonly Token[], index: number, text: string): number {
	return tokens[index]?.start ?? text.length;
}

function isTiny(tokens: readonly Token[], op: TokenOp, text: string): boolean {
	let words = 0;
	for (let index = op.oldStart; index < op.oldEnd; index++) {
		if (tokens[index]?.word) words++;
	}
	return words === 0 || (words === 1 && text.trim().length <= 3);
}

/**
 * Moves whitespace that both sides of a replacement start or end with out into unchanged text,
 * so "big dog" → "small dog" doesn't strike and re-insert the space between the words.
 */
function trimHunks(hunks: readonly Hunk[], oldText: string, newText: string): Hunk[] {
	const trimmed: Hunk[] = [];
	for (const hunk of hunks) {
		if (!hunk.changed || hunk.oldStart === hunk.oldEnd || hunk.newStart === hunk.newEnd) {
			trimmed.push(hunk);
			continue;
		}
		let lead = 0;
		while (
			hunk.oldStart + lead < hunk.oldEnd &&
			hunk.newStart + lead < hunk.newEnd &&
			sharedWhitespace(oldText[hunk.oldStart + lead], newText[hunk.newStart + lead])
		) {
			lead++;
		}
		let tail = 0;
		while (
			hunk.oldEnd - tail > hunk.oldStart + lead &&
			hunk.newEnd - tail > hunk.newStart + lead &&
			sharedWhitespace(oldText[hunk.oldEnd - tail - 1], newText[hunk.newEnd - tail - 1])
		) {
			tail++;
		}
		const middle: Hunk = {
			changed: true,
			oldStart: hunk.oldStart + lead,
			oldEnd: hunk.oldEnd - tail,
			newStart: hunk.newStart + lead,
			newEnd: hunk.newEnd - tail,
		};
		if (lead > 0) {
			trimmed.push({ ...hunk, changed: false, oldEnd: middle.oldStart, newEnd: middle.newStart });
		}
		if (middle.oldStart < middle.oldEnd || middle.newStart < middle.newEnd) trimmed.push(middle);
		if (tail > 0) {
			trimmed.push({ ...hunk, changed: false, oldStart: middle.oldEnd, newStart: middle.newEnd });
		}
	}
	return trimmed;
}

function sharedWhitespace(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && a === b && WHITESPACE.test(a);
}

function runStarts(runs: readonly TextRun[]): number[] {
	const starts: number[] = [];
	let offset = 0;
	for (const run of runs) {
		starts.push(offset);
		offset += run.text.length;
	}
	return starts;
}

/** The parts of `runs` between two character offsets of their joined text. */
function sliceRuns(
	runs: readonly TextRun[],
	starts: readonly number[],
	from: number,
	to: number,
): TextRun[] {
	const slice: TextRun[] = [];
	if (from >= to) return slice;
	let low = 0;
	let high = runs.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if ((starts[middle] ?? 0) <= from) low = middle;
		else high = middle - 1;
	}
	for (let index = low; index < runs.length; index++) {
		const run = runs[index];
		const start = starts[index];
		if (!run || start === undefined || start >= to) break;
		const sliceStart = Math.max(from, start) - start;
		const sliceEnd = Math.min(to, start + run.text.length) - start;
		if (sliceEnd > sliceStart) {
			slice.push({ text: run.text.slice(sliceStart, sliceEnd), marks: run.marks });
		}
	}
	return slice;
}

/** Appends equal text, cut wherever either side's marks change. */
function appendSame(
	segments: DiffSegment[],
	oldRuns: readonly TextRun[],
	newRuns: readonly TextRun[],
): void {
	let oldIndex = 0;
	let newIndex = 0;
	let oldOffset = 0;
	let newOffset = 0;
	while (oldIndex < oldRuns.length && newIndex < newRuns.length) {
		const oldRun = oldRuns[oldIndex];
		const newRun = newRuns[newIndex];
		if (!oldRun || !newRun) break;
		const length = Math.min(oldRun.text.length - oldOffset, newRun.text.length - newOffset);
		appendSegment(segments, {
			text: newRun.text.slice(newOffset, newOffset + length),
			change: "same",
			marks: newRun.marks,
			hunk: null,
			formatChanged: !sameMarks(oldRun.marks, newRun.marks),
		});
		oldOffset += length;
		newOffset += length;
		if (oldOffset === oldRun.text.length) {
			oldIndex++;
			oldOffset = 0;
		}
		if (newOffset === newRun.text.length) {
			newIndex++;
			newOffset = 0;
		}
	}
}

function appendSegment(segments: DiffSegment[], segment: DiffSegment): void {
	const last = segments.at(-1);
	if (
		last &&
		last.change === segment.change &&
		last.hunk === segment.hunk &&
		last.formatChanged === segment.formatChanged &&
		sameMarks(last.marks, segment.marks)
	) {
		segments[segments.length - 1] = { ...last, text: last.text + segment.text };
	} else {
		segments.push(segment);
	}
}
