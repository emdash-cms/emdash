import type { DiffContext } from "./context.js";
import { createInterner, lcsPairs } from "./lcs.js";
import { blockSignature } from "./normalize.js";
import { countWords, tokenizeCode, tokenizeWords, wordBag } from "./tokens.js";
import type { NormalizedBlock } from "./types.js";

interface Alignment {
	/** Old block index to the new block index it pairs with. */
	pairs: ReadonlyMap<number, number>;
	/** Old indices of paired blocks that changed position. */
	moved: ReadonlySet<number>;
}

type Pair = readonly [number, number];

/**
 * Pairs old blocks with new ones. Portable Text keys are a strong hint but not an identity:
 * seeded and imported content has none, and an editing session that started without keys writes
 * fresh ones on every save. So after the equal blocks at the start and end, unique keys pair
 * blocks when they can be trusted, then equal content, then similar content, and finally
 * identical blocks that changed place pair as moved.
 */
export function alignBlocks(
	oldBlocks: readonly NormalizedBlock[],
	newBlocks: readonly NormalizedBlock[],
	context: DiffContext,
): Alignment {
	const aligner = new BlockAligner(oldBlocks, newBlocks, context);
	aligner.align();
	return { pairs: aligner.pairs, moved: aligner.moved };
}

class BlockAligner {
	readonly pairs = new Map<number, number>();
	readonly moved = new Set<number>();
	private readonly pairedNew = new Set<number>();
	private readonly bags = new Map<NormalizedBlock, Map<string, number>>();
	private readonly oldBlocks: readonly NormalizedBlock[];
	private readonly newBlocks: readonly NormalizedBlock[];
	private readonly context: DiffContext;
	private readonly keysTrusted: boolean;

	constructor(
		oldBlocks: readonly NormalizedBlock[],
		newBlocks: readonly NormalizedBlock[],
		context: DiffContext,
	) {
		this.oldBlocks = oldBlocks;
		this.newBlocks = newBlocks;
		this.context = context;
		this.keysTrusted = this.keysAreTrusted();
	}

	align(): void {
		const oldBlocks = this.oldBlocks;
		const newBlocks = this.newBlocks;

		let head = 0;
		while (head < oldBlocks.length && head < newBlocks.length && this.equal(head, head)) {
			this.pair(head, head);
			head++;
		}
		let oldTail = oldBlocks.length;
		let newTail = newBlocks.length;
		while (oldTail > head && newTail > head && this.equal(oldTail - 1, newTail - 1)) {
			oldTail--;
			newTail--;
			this.pair(oldTail, newTail);
		}

		const anchors = this.keysTrusted ? this.pairKeys(head, oldTail, newTail) : [];
		const bounds: Pair[] = [[head - 1, head - 1], ...anchors, [oldTail, newTail]];
		for (let index = 1; index < bounds.length; index++) {
			const [oldFrom, newFrom] = bounds[index - 1] ?? [0, 0];
			const [oldTo, newTo] = bounds[index] ?? [0, 0];
			this.alignGap(
				range(oldFrom + 1, oldTo).filter((o) => !this.pairs.has(o)),
				range(newFrom + 1, newTo).filter((n) => !this.pairedNew.has(n)),
			);
		}

		this.pairMoved();
	}

	private pair(oldIndex: number, newIndex: number, moved = false): void {
		this.pairs.set(oldIndex, newIndex);
		this.pairedNew.add(newIndex);
		if (moved) this.moved.add(oldIndex);
	}

	private equal(oldIndex: number, newIndex: number): boolean {
		const oldBlock = this.oldBlocks[oldIndex];
		const newBlock = this.newBlocks[newIndex];
		return !!oldBlock && !!newBlock && blockSignature(oldBlock) === blockSignature(newBlock);
	}

	/**
	 * Pairs blocks whose key is unique on both sides and whose type matches. The longest run of
	 * pairs that keeps document order become anchors; the rest moved.
	 */
	private pairKeys(from: number, oldTo: number, newTo: number): Pair[] {
		const oldByKey = uniqueKeys(this.oldBlocks);
		const newByKey = uniqueKeys(this.newBlocks);
		const candidates: Pair[] = [];
		for (let n = from; n < newTo; n++) {
			const key = this.newBlocks[n]?.key;
			if (!key || newByKey.get(key) !== n) continue;
			const o = oldByKey.get(key);
			if (o === undefined || o < from || o >= oldTo) continue;
			if (this.oldBlocks[o]?.type !== this.newBlocks[n]?.type) continue;
			candidates.push([o, n]);
		}

		const inOrder = longestIncreasingSubsequence(candidates.map(([o]) => o));
		const anchors: Pair[] = [];
		candidates.forEach(([o, n], index) => {
			const anchor = inOrder.has(index);
			this.pair(o, n, !anchor);
			if (anchor) anchors.push([o, n]);
		});
		return anchors;
	}

	/** Pairs equal blocks in order, then similar blocks between those matches. */
	private alignGap(oldGap: readonly number[], newGap: readonly number[]): void {
		if (oldGap.length === 0 || newGap.length === 0) return;
		let oldFrom = 0;
		let newFrom = 0;
		for (const [i, j] of [
			...this.matchEqual(oldGap, newGap),
			[oldGap.length, newGap.length] as const,
		]) {
			this.pairSimilar(oldGap.slice(oldFrom, i), newGap.slice(newFrom, j));
			const o = oldGap[i];
			const n = newGap[j];
			if (o !== undefined && n !== undefined) this.pair(o, n);
			oldFrom = i + 1;
			newFrom = j + 1;
		}
	}

	/** Positions in the two gaps of blocks with equal content, in order on both sides. */
	private matchEqual(oldGap: readonly number[], newGap: readonly number[]): Pair[] {
		const oldSignatures = oldGap.map((o) => this.signature(this.oldBlocks, o));
		const newSignatures = newGap.map((n) => this.signature(this.newBlocks, n));
		if (oldGap.length * newGap.length <= this.context.limits.maxBlockLcsCells) {
			const intern = createInterner();
			return lcsPairs(intern(oldSignatures), intern(newSignatures));
		}

		// Too many blocks to compare every pair: take each new block's next equal old block.
		const positions = new Map<string, number[]>();
		oldSignatures.forEach((signature, i) => {
			const list = positions.get(signature);
			if (list) list.push(i);
			else positions.set(signature, [i]);
		});
		const matches: Pair[] = [];
		const next = new Map<string, number>();
		let lastOld = -1;
		newSignatures.forEach((signature, j) => {
			const list = positions.get(signature);
			if (!list) return;
			let cursor = next.get(signature) ?? 0;
			while (cursor < list.length && (list[cursor] ?? 0) <= lastOld) cursor++;
			next.set(signature, cursor + 1);
			const i = list[cursor];
			if (i === undefined) return;
			matches.push([i, j]);
			lastOld = i;
		});
		return matches;
	}

	/**
	 * Pairs the blocks left between two equal matches by similarity, keeping their order. A lone
	 * old and a lone new block of the same kind pair however different they are, as an edit in
	 * place, unless trusted keys tell them apart.
	 */
	private pairSimilar(oldSub: readonly number[], newSub: readonly number[]): void {
		if (oldSub.length === 0 || newSub.length === 0) return;
		if (this.pairLone(oldSub, newSub)) return;
		const rows = oldSub.length;
		const columns = newSub.length;
		const { maxSimilarityCells, maxSimilarityWords } = this.context.limits;
		if (rows * columns > maxSimilarityCells) return;
		const oldWords = oldSub.reduce((total, o) => total + this.wordsIn(this.oldBlocks[o]), 0);
		const newWords = newSub.reduce((total, n) => total + this.wordsIn(this.newBlocks[n]), 0);
		if (oldWords * columns + newWords * rows > maxSimilarityWords) return;

		const scores = new Float64Array(rows * columns);
		// best[i * (columns + 1) + j] is the highest total score pairing oldSub[i..] with newSub[j..].
		const best = new Float64Array((rows + 1) * (columns + 1));
		const width = columns + 1;
		for (let i = rows - 1; i >= 0; i--) {
			for (let j = columns - 1; j >= 0; j--) {
				const score = this.similarity(oldSub[i] ?? 0, newSub[j] ?? 0);
				scores[i * columns + j] = score;
				best[i * width + j] = Math.max(
					best[(i + 1) * width + j] ?? 0,
					best[i * width + j + 1] ?? 0,
					score > 0 ? (best[(i + 1) * width + j + 1] ?? 0) + score : 0,
				);
			}
		}

		const matches: Pair[] = [];
		let i = 0;
		let j = 0;
		while (i < rows && j < columns) {
			const score = scores[i * columns + j] ?? 0;
			const total = best[i * width + j] ?? 0;
			if (score > 0 && total === (best[(i + 1) * width + j + 1] ?? 0) + score) {
				matches.push([i, j]);
				i++;
				j++;
			} else if (total === (best[(i + 1) * width + j] ?? 0)) {
				i++;
			} else {
				j++;
			}
		}

		let oldFrom = 0;
		let newFrom = 0;
		for (const [matchI, matchJ] of [...matches, [rows, columns] as const]) {
			this.pairLone(oldSub.slice(oldFrom, matchI), newSub.slice(newFrom, matchJ));
			const o = oldSub[matchI];
			const n = newSub[matchJ];
			if (o !== undefined && n !== undefined) this.pair(o, n);
			oldFrom = matchI + 1;
			newFrom = matchJ + 1;
		}
	}

	private pairLone(oldSub: readonly number[], newSub: readonly number[]): boolean {
		if (oldSub.length !== 1 || newSub.length !== 1) return false;
		const o = oldSub[0] ?? 0;
		const n = newSub[0] ?? 0;
		const oldBlock = this.oldBlocks[o];
		const newBlock = this.newBlocks[n];
		if (!oldBlock || !newBlock || !sameKind(oldBlock, newBlock)) return false;
		if (this.keysTellApart(oldBlock, newBlock)) return false;
		this.pair(o, n);
		return true;
	}

	private keysTellApart(a: NormalizedBlock, b: NormalizedBlock): boolean {
		return this.keysTrusted && a.key !== null && b.key !== null && a.key !== b.key;
	}

	/**
	 * Whether keys identify blocks across the two revisions: at least half of the keyed blocks on
	 * the side with fewer of them find a block of the same type with their key on the other side.
	 * Keyless content, and a session that writes fresh keys on every save, find none. Tools that
	 * number keys from the start on every save reuse them for other blocks, which shows when a key
	 * pairs different blocks while one of them is still there unchanged.
	 */
	private keysAreTrusted(): boolean {
		const { oldBlocks, newBlocks } = this;
		const substantialSignatures = (blocks: readonly NormalizedBlock[]) =>
			new Set(blocks.filter((block) => this.substantial(block)).map(blockSignature));
		const oldSignatures = substantialSignatures(oldBlocks);
		const newSignatures = substantialSignatures(newBlocks);
		const oldByKey = uniqueKeys(oldBlocks);
		let shared = 0;
		for (const [key, n] of uniqueKeys(newBlocks)) {
			const o = oldByKey.get(key);
			const oldBlock = o === undefined ? undefined : oldBlocks[o];
			const newBlock = newBlocks[n];
			if (!oldBlock || !newBlock || oldBlock.type !== newBlock.type) continue;
			const oldSignature = blockSignature(oldBlock);
			const newSignature = blockSignature(newBlock);
			if (
				oldSignature !== newSignature &&
				(newSignatures.has(oldSignature) || oldSignatures.has(newSignature))
			) {
				return false;
			}
			shared++;
		}
		const keyed = Math.min(countKeyed(oldBlocks), countKeyed(newBlocks));
		return shared > 0 && shared * 2 >= keyed;
	}

	/** Identical blocks left unpaired on both sides, each unique among the leftovers, moved. */
	private pairMoved(): void {
		const candidates = new Map<string, { old: number[]; new: number[] }>();
		const collect = (blocks: readonly NormalizedBlock[], side: "old" | "new") => {
			blocks.forEach((block, index) => {
				const paired = side === "old" ? this.pairs.has(index) : this.pairedNew.has(index);
				if (paired || !this.substantial(block)) return;
				const signature = blockSignature(block);
				let entry = candidates.get(signature);
				if (!entry) {
					entry = { old: [], new: [] };
					candidates.set(signature, entry);
				}
				entry[side].push(index);
			});
		};
		collect(this.oldBlocks, "old");
		collect(this.newBlocks, "new");
		for (const entry of candidates.values()) {
			const [o] = entry.old;
			const [n] = entry.new;
			if (entry.old.length === 1 && entry.new.length === 1 && o !== undefined && n !== undefined) {
				this.pair(o, n, true);
			}
		}
	}

	/** Whether a block says enough on its own to recognise it in another place. */
	private substantial(block: NormalizedBlock): boolean {
		switch (block.kind) {
			case "text":
				return countWords(block.text, this.context.locale) >= 3;
			case "image":
				return block.asset !== "";
			case "code":
				return block.code.trim() !== "";
			case "opaque":
				return true;
		}
	}

	private signature(blocks: readonly NormalizedBlock[], index: number): string {
		const block = blocks[index];
		return block ? blockSignature(block) : "";
	}

	private similarity(oldIndex: number, newIndex: number): number {
		const oldBlock = this.oldBlocks[oldIndex];
		const newBlock = this.newBlocks[newIndex];
		if (!oldBlock || !newBlock) return 0;
		if (oldBlock.kind === "image" && newBlock.kind === "image") {
			if (oldBlock.asset && oldBlock.asset === newBlock.asset) return 1;
			return oldBlock.caption && oldBlock.caption === newBlock.caption ? 0.6 : 0;
		}
		if (
			(oldBlock.kind === "text" && newBlock.kind === "text") ||
			(oldBlock.kind === "code" && newBlock.kind === "code")
		) {
			return bagSimilarity(this.bag(oldBlock), this.bag(newBlock));
		}
		return 0;
	}

	/** The distinct words a similarity comparison walks for a block. */
	private wordsIn(block: NormalizedBlock | undefined): number {
		return block ? this.bag(block).size : 0;
	}

	private bag(block: NormalizedBlock): Map<string, number> {
		let bag = this.bags.get(block);
		if (!bag) {
			const locale = this.context.locale;
			bag =
				block.kind === "text"
					? wordBag(tokenizeWords(block.text, locale), locale)
					: block.kind === "code"
						? wordBag(tokenizeCode(block.code), locale)
						: new Map<string, number>();
			this.bags.set(block, bag);
		}
		return bag;
	}
}

function sameKind(a: NormalizedBlock, b: NormalizedBlock): boolean {
	return a.kind === b.kind && (a.kind !== "opaque" || a.type === b.type);
}

/**
 * Dice coefficient of two word bags when at least half the words are shared. A short block
 * mostly contained in a longer one, such as a paragraph that grew, still counts as similar.
 */
function bagSimilarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
	let sizeA = 0;
	let sizeB = 0;
	let common = 0;
	for (const count of a.values()) sizeA += count;
	for (const [word, count] of b) {
		sizeB += count;
		common += Math.min(count, a.get(word) ?? 0);
	}
	if (common === 0) return 0;
	const dice = (2 * common) / (sizeA + sizeB);
	if (dice >= 0.5) return dice;
	const smaller = Math.min(sizeA, sizeB);
	return smaller >= 3 && common / smaller >= 0.8 ? 0.5 : 0;
}

function countKeyed(blocks: readonly NormalizedBlock[]): number {
	return blocks.filter((block) => block.key !== null).length;
}

/** Map from each key that occurs exactly once to its index. */
function uniqueKeys(blocks: readonly NormalizedBlock[]): Map<string, number> {
	const indexes = new Map<string, number>();
	const repeated = new Set<string>();
	blocks.forEach((block, index) => {
		if (block.key === null) return;
		if (indexes.has(block.key)) repeated.add(block.key);
		else indexes.set(block.key, index);
	});
	for (const key of repeated) indexes.delete(key);
	return indexes;
}

/** Positions in `values` of one longest strictly increasing subsequence. */
function longestIncreasingSubsequence(values: readonly number[]): Set<number> {
	// tails[k] is the position of the smallest value ending an increasing run of length k + 1.
	const tails: number[] = [];
	const previous = new Int32Array(values.length).fill(-1);
	values.forEach((value, position) => {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((values[tails[middle] ?? 0] ?? 0) < value) low = middle + 1;
			else high = middle;
		}
		if (low > 0) previous[position] = tails[low - 1] ?? -1;
		tails[low] = position;
	});
	const result = new Set<number>();
	for (let position = tails.at(-1) ?? -1; position >= 0; position = previous[position] ?? -1) {
		result.add(position);
	}
	return result;
}

function range(from: number, to: number): number[] {
	return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
}
