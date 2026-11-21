/**
 * Experimental speculative query replay on top of the coalescing D1 driver.
 *
 * Caches the query *plan* of an anonymous render, never its results. When a
 * plan for the path exists, the connection sends every planned SELECT as one
 * `batch()` through the session's op chain as soon as it is created, and
 * answers the render's queries from that batch when their sql and params
 * match exactly. Everything else (misses, writes) takes the coalescing path
 * unchanged. At the end of the request the connection compares what ran with
 * what was planned so the caller can rewrite the plan in the background.
 *
 * Memo semantics:
 * - Key: exact sql text plus JSON-encoded params. Statements with params that
 *   are not plain JSON primitives are never recorded or served.
 * - Repeated identical SELECTs share one planned statement. Every consumer
 *   gets its own copy of the rows, so mutating a result can't leak into
 *   another consumer's.
 * - Any statement that may write clears the memo and discards a batch still
 *   in flight (read-your-writes): later reads take the normal path. Only
 *   SELECTs are ever recorded or replayed; a read-only `WITH` runs on the
 *   normal path without clearing the memo (see mayWrite).
 * - A rejected batch (D1 batches are atomic) serves nothing; the caller drops
 *   the plan and the request continues as if it had none.
 */

import type { CompiledQuery, QueryResult } from "kysely";

import {
	CoalescingD1Connection,
	CoalescingD1Dialect,
	mapD1Result,
	SELECT_PATTERN,
} from "./coalescing-d1.js";
import { observeRpc, type RpcHook } from "./d1-dialect.js";
import {
	boundPlan,
	isReplayableSql,
	isReplayParam,
	type ReplayPlan,
	type ReplayStatement,
} from "./replay-plan-store.js";

/** Live counters, read by the runtime for Server-Timing and the query summary. */
export interface ReplayCounters {
	/** Queries answered from the replay batch. */
	hits: number;
	/** SELECTs that ran but were not answered from the batch. */
	misses: number;
	/** Planned statements not (yet) consumed. Final once the request ends. */
	waste: number;
}

export interface ReplayOptions {
	/** The plan for this request, or null. A rejected promise counts as none. */
	plan: Promise<ReplayPlan | null> | ReplayPlan | null;
	counters: ReplayCounters;
	/** Called once if the replay batch rejects. */
	onBatchFailed?: () => void;
}

/** What learning concluded at the end of the request. */
export interface ReplayOutcome {
	/** The plan to store, or null to leave the stored one alone. */
	nextPlan: ReplayPlan | null;
	/** Whether the stored plan's batch was rejected. */
	failed: boolean;
	/** Whether this request had a (non-empty, valid) plan to replay. */
	hadPlan: boolean;
}

const WITH_PATTERN = /^with\b/i;
const WRITE_KEYWORD = /\b(?:insert|update|delete|replace)\b/i;

/**
 * Whether a statement might write, for clearing the memo. SELECTs never do.
 * A `WITH` statement can only write through an INSERT, UPDATE, DELETE or
 * REPLACE, so one that never mentions those words is a read; any mention
 * (even in a literal) counts as a write, erring towards clearing.
 */
function mayWrite(sql: string): boolean {
	const trimmed = sql.trim();
	if (SELECT_PATTERN.test(trimmed)) return false;
	return !WITH_PATTERN.test(trimmed) || WRITE_KEYWORD.test(trimmed);
}

function replayKey(sql: string, params: readonly unknown[]): string | null {
	if (!params.every(isReplayParam)) return null;
	return `${sql}\u0000${JSON.stringify(params)}`;
}

function cloneResult<R>(result: QueryResult<R>): QueryResult<R> {
	return { ...result, rows: structuredClone(result.rows) };
}

interface Observation {
	statement: ReplayStatement;
	key: string;
	succeeded: boolean;
}

export class ReplayD1Connection extends CoalescingD1Connection {
	readonly #counters: ReplayCounters;
	readonly #onBatchFailed: (() => void) | undefined;
	/** Results of the replay batch by key. Cleared by any write. */
	readonly #memo = new Map<string, QueryResult<unknown>>();
	/** Bumped by every non-SELECT; results from an older generation are void. */
	#generation = 0;
	/** Planned statements, in plan order, once the plan has loaded. */
	#planned: ReplayStatement[] | null = null;
	#plannedKeys = new Set<string>();
	readonly #consumed = new Set<string>();
	/** Resolves once the plan is known (null when there is none). */
	readonly #planLoaded: Promise<Set<string> | null>;
	/** Resolves once the replay batch has settled, or at once with no plan. */
	readonly #batchSettled: Promise<void>;
	#failed = false;
	/** First occurrence of each executed recordable SELECT, in issue order. */
	readonly #observed = new Map<string, Observation>();
	#finished = false;

	constructor(database: D1Database, onRpc: RpcHook | undefined, options: ReplayOptions) {
		super(database, onRpc);
		this.#counters = options.counters;
		this.#onBatchFailed = options.onBatchFailed;
		this.#planLoaded = Promise.resolve(options.plan).then(
			(plan) => this.#acceptPlan(plan),
			() => null,
		);
		this.#batchSettled = this.#planLoaded.then((keys) => (keys ? this.#replay() : undefined));
	}

	#acceptPlan(plan: ReplayPlan | null): Set<string> | null {
		if (!plan || plan.statements.length === 0) return null;
		const statements: ReplayStatement[] = [];
		const keys = new Set<string>();
		for (const statement of plan.statements) {
			// Plans are validated on load; this is the last line before the
			// database, so check again rather than trust the store.
			if (!isReplayableSql(statement.sql)) return null;
			const key = replayKey(statement.sql, statement.params);
			if (key === null) return null;
			if (keys.has(key)) continue;
			keys.add(key);
			statements.push(statement);
		}
		this.#planned = statements;
		this.#plannedKeys = keys;
		this.#counters.waste = keys.size;
		return keys;
	}

	async #replay(): Promise<void> {
		const planned = this.#planned;
		if (!planned) return;
		const generation = this.#generation;
		try {
			const results = await this.runExclusive(async () => {
				// A write queued ahead of the batch makes its results useless.
				if (this.#generation !== generation) return null;
				const statements = planned.map((s) => this.session.prepare(s.sql).bind(...s.params));
				return observeRpc(this.rpcHook, statements.length, () => this.session.batch(statements));
			});
			if (!results || this.#generation !== generation) return;
			for (let i = 0; i < planned.length; i++) {
				const statement = planned[i];
				const result = results[i];
				if (!statement || !result) continue;
				const key = replayKey(statement.sql, statement.params);
				if (key === null) continue;
				try {
					this.#memo.set(key, mapD1Result(result));
				} catch {
					// A per-statement error result is simply not served.
				}
			}
		} catch {
			this.#failed = true;
			this.#memo.clear();
			try {
				this.#onBatchFailed?.();
			} catch {
				// Never surface replay failures.
			}
		}
	}

	override async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		const { sql, parameters } = compiledQuery;
		if (!SELECT_PATTERN.test(sql.trim())) {
			if (mayWrite(sql)) {
				this.#generation++;
				this.#memo.clear();
			}
			return super.executeQuery<R>(compiledQuery);
		}

		const key = isReplayableSql(sql) ? replayKey(sql, parameters) : null;
		const observation = key ? this.#observe(key, sql, parameters) : undefined;

		if (key) {
			const plannedKeys = await this.#planLoaded;
			if (plannedKeys?.has(key)) {
				await this.#batchSettled;
				const hit = this.#memo.get(key);
				if (hit) {
					this.#counters.hits++;
					if (!this.#consumed.has(key)) {
						this.#consumed.add(key);
						this.#counters.waste = Math.max(0, this.#counters.waste - 1);
					}
					if (observation) observation.succeeded = true;
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- memo holds the QueryResult this exact statement produced
					return cloneResult(hit as QueryResult<R>);
				}
			}
		}

		this.#counters.misses++;
		const result = await super.executeQuery<R>(compiledQuery);
		if (observation) observation.succeeded = true;
		return result;
	}

	#observe(key: string, sql: string, parameters: readonly unknown[]): Observation | undefined {
		if (this.#finished) return undefined;
		const existing = this.#observed.get(key);
		if (existing) return existing;
		// replayKey already checked every param is a primitive.
		const params = parameters.filter(isReplayParam);
		const observation: Observation = { statement: { sql, params }, key, succeeded: false };
		this.#observed.set(key, observation);
		return observation;
	}

	/**
	 * Stop recording and decide whether the stored plan should change.
	 *
	 * Steady state writes nothing: a plan is rewritten only when the render
	 * ran SELECTs it did not predict (the new plan is the union, observed
	 * order first), when most of it went unused (the new plan is what ran),
	 * or when its batch failed (the new plan is what ran). Unused entries alone
	 * never trigger a write, because isolate-level caches make some reads come
	 * and go between otherwise identical renders. Statements that failed in
	 * this request are never recorded.
	 */
	finish(): ReplayOutcome {
		this.#finished = true;
		const observed = [...this.#observed.values()].filter((o) => o.succeeded);
		const observedKeys = new Set(observed.map((o) => o.key));
		const planned = this.#planned;
		if (this.#failed || !planned) {
			return {
				nextPlan: boundPlan(observed.map((o) => o.statement)),
				failed: this.#failed,
				hadPlan: planned !== null,
			};
		}
		const unpredicted = observed.filter((o) => !this.#plannedKeys.has(o.key));
		const unused = planned.filter((s) => {
			const key = replayKey(s.sql, s.params);
			return key !== null && !observedKeys.has(key);
		});
		if (unused.length * 2 > planned.length) {
			return {
				nextPlan: boundPlan(observed.map((o) => o.statement)),
				failed: false,
				hadPlan: true,
			};
		}
		if (unpredicted.length > 0) {
			return {
				nextPlan: boundPlan([...observed.map((o) => o.statement), ...unused]),
				failed: false,
				hadPlan: true,
			};
		}
		return { nextPlan: null, failed: false, hadPlan: true };
	}
}

/** Coalescing D1 dialect whose connection replays `options.plan`. */
export class ReplayD1Dialect extends CoalescingD1Dialect {
	readonly #options: ReplayOptions;
	#connection: ReplayD1Connection | undefined;

	constructor(
		config: ConstructorParameters<typeof CoalescingD1Dialect>[0],
		options: ReplayOptions,
	) {
		super(config);
		this.#options = options;
	}

	protected override createConnection(
		database: D1Database,
		onRpc: RpcHook | undefined,
	): CoalescingD1Connection {
		this.#connection = new ReplayD1Connection(database, onRpc, this.#options);
		return this.#connection;
	}

	/** The connection's learning outcome; null before the Kysely is built. */
	finish(): ReplayOutcome | null {
		return this.#connection?.finish() ?? null;
	}
}
