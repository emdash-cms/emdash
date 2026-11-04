import type { DiffLimits, DiffOptions } from "./types.js";

const DEFAULT_LIMITS: DiffLimits = {
	maxTokenCellsPerText: 1_000_000,
	maxTokenCellsTotal: 5_000_000,
	maxBlockLcsCells: 250_000,
	maxSimilarityCells: 40_000,
	maxSimilarityWords: 8_000_000,
};

/** State shared by everything one revision diff computes. */
export interface DiffContext {
	readonly locale: string | undefined;
	readonly limits: DiffLimits;
	/** Token cells the rest of the diff may still spend on word diffs. */
	cellsLeft: number;
	/** The next id for a replacement hunk; ids are unique within one revision diff. */
	nextHunk: number;
}

export function createDiffContext(options: DiffOptions): DiffContext {
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	return { locale: options.locale, limits, cellsLeft: limits.maxTokenCellsTotal, nextHunk: 0 };
}
