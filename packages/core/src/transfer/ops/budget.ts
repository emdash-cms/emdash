/**
 * Work budget for one `advance` step.
 *
 * Queries are counted by the request's `metrics.dbCount` (the Kysely log hook
 * bumps it), so the budget also covers queries the request ran before the
 * step. A unit of work may start only if its estimated query cost still fits
 * under the ceiling with `stepClosingQueries` to spare for the writes that end
 * the step, and only if its bytes fit the step's byte budget. The
 * byte check skips the first unit of a step, so one blob larger than the byte
 * budget gets a step of its own.
 */

import { getRequestContext } from "../../request-context.js";
import { TRANSFER_LIMITS } from "../format/limits.js";

export interface StepBudget {
	queries: number;
	bytes: number;
}

export interface StepBudgetOptions {
	/** Stop starting units once the request has run this many queries. */
	queryCeiling?: number;
	/** Media bytes per step. */
	bytes?: number;
	/** Query counter; defaults to the current request's metrics. */
	metrics?: { dbCount: number };
}

export class TransferStepBudget {
	readonly #queryCeiling: number;
	readonly #byteLimit: number;
	readonly #metrics: { dbCount: number } | undefined;
	#bytesUsed = 0;
	#units = 0;

	get #unitCeiling(): number {
		return this.#queryCeiling - TRANSFER_LIMITS.stepClosingQueries;
	}

	constructor(options: StepBudgetOptions = {}) {
		this.#queryCeiling = options.queryCeiling ?? TRANSFER_LIMITS.stepQueryCeiling;
		this.#byteLimit = options.bytes ?? TRANSFER_LIMITS.stepBytes;
		this.#metrics = options.metrics ?? getRequestContext()?.metrics;
	}

	/**
	 * Whether a unit costing `cost` may start. Defaults to the standard unit
	 * query cost and no bytes. Without request metrics only bytes are limited.
	 */
	canStart(cost: Partial<StepBudget> = {}): boolean {
		const queries = cost.queries ?? TRANSFER_LIMITS.stepQueries;
		const bytes = cost.bytes ?? 0;
		if (this.#metrics && this.#metrics.dbCount + queries > this.#unitCeiling) return false;
		if (this.#units === 0) return true;
		return bytes === 0 || this.#bytesUsed + bytes <= this.#byteLimit;
	}

	/** Record that a unit started, with the bytes it will move. */
	start(bytes = 0): void {
		this.#units++;
		this.#bytesUsed += bytes;
	}

	get units(): number {
		return this.#units;
	}

	get bytesUsed(): number {
		return this.#bytesUsed;
	}

	/** Remaining budget, for display and for sizing batch reads. */
	remaining(): StepBudget {
		return {
			queries: this.#metrics
				? Math.max(0, this.#unitCeiling - this.#metrics.dbCount)
				: Number.POSITIVE_INFINITY,
			bytes: Math.max(0, this.#byteLimit - this.#bytesUsed),
		};
	}
}
