/**
 * Storage for speculative query replay plans (see replay-d1.ts).
 *
 * A plan is the ordered list of SELECTs (sql + params) one anonymous render
 * of a path ran. It is a prediction, never data: a stale or missing plan
 * costs a wasted or missed statement, not a wrong page. Stores therefore
 * favour cheap reads and tolerate loss, and every plan that comes out of one
 * is validated before it can reach the database.
 */

import { SELECT_PATTERN } from "./coalescing-d1.js";

export const REPLAY_PLAN_VERSION = 1;
/** Upper bound on statements in one plan (and so in one replay batch). */
export const MAX_PLAN_STATEMENTS = 64;
/** Upper bound on a plan's serialized size. */
export const MAX_PLAN_BYTES = 64 * 1024;

export type ReplayParam = string | number | boolean | null;

export interface ReplayStatement {
	sql: string;
	params: ReplayParam[];
}

export interface ReplayPlan {
	v: typeof REPLAY_PLAN_VERSION;
	statements: ReplayStatement[];
}

/**
 * Where plans live. Implementations must be safe to call from any request and
 * must never throw: a failed read is a missing plan, a failed write is lost.
 * Keys are opaque strings built by the caller (they already carry the build,
 * host and path); a store only needs to map them to its own key space.
 */
export interface ReplayPlanStore {
	get(key: string): Promise<ReplayPlan | null>;
	put(key: string, plan: ReplayPlan): Promise<void>;
	delete(key: string): Promise<void>;
}

/** Plain JSON primitives only; anything else is not replayable. */
export function isReplayParam(value: unknown): value is ReplayParam {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

/**
 * Whether `sql` may be sent in a replay batch: a single plain SELECT. The
 * semicolon check keeps a statement from smuggling a second one behind it.
 */
export function isReplayableSql(sql: string): boolean {
	return SELECT_PATTERN.test(sql.trim()) && !sql.includes(";");
}

/**
 * Validate an untrusted value as a plan. Returns null for anything that is
 * not exactly a current-version plan of replayable statements within bounds,
 * so a corrupt or poisoned entry can never run a write.
 */
export function parseReplayPlan(value: unknown): ReplayPlan | null {
	if (!value || typeof value !== "object") return null;
	if (!("v" in value) || value.v !== REPLAY_PLAN_VERSION) return null;
	if (!("statements" in value) || !Array.isArray(value.statements)) return null;
	const raw: unknown[] = value.statements;
	if (raw.length === 0 || raw.length > MAX_PLAN_STATEMENTS) return null;
	const statements: ReplayStatement[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") return null;
		if (!("sql" in entry) || typeof entry.sql !== "string" || !isReplayableSql(entry.sql)) {
			return null;
		}
		if (!("params" in entry) || !Array.isArray(entry.params)) return null;
		const params: unknown[] = entry.params;
		if (!params.every(isReplayParam)) return null;
		statements.push({ sql: entry.sql, params: [...params] });
	}
	return { v: REPLAY_PLAN_VERSION, statements };
}

/**
 * Build a plan from statements in order, keeping as many as fit the bounds.
 * Returns null when nothing replayable is left.
 */
export function boundPlan(statements: readonly ReplayStatement[]): ReplayPlan | null {
	const kept: ReplayStatement[] = [];
	let bytes = 0;
	for (const statement of statements) {
		if (kept.length >= MAX_PLAN_STATEMENTS) break;
		if (!isReplayableSql(statement.sql) || !statement.params.every(isReplayParam)) continue;
		const size = JSON.stringify(statement).length;
		if (bytes + size > MAX_PLAN_BYTES) break;
		bytes += size;
		kept.push(statement);
	}
	return kept.length > 0 ? { v: REPLAY_PLAN_VERSION, statements: kept } : null;
}

/**
 * Isolate-level LRU. Lookups are synchronous in effect, so a warm isolate
 * finds its plan without any I/O.
 */
export class MemoryPlanStore implements ReplayPlanStore {
	readonly #entries = new Map<string, ReplayPlan>();
	readonly #limit: number;

	constructor(limit = 256) {
		this.#limit = limit;
	}

	async get(key: string): Promise<ReplayPlan | null> {
		return this.peek(key);
	}

	/** Synchronous lookup; refreshes the entry's recency. */
	peek(key: string): ReplayPlan | null {
		const plan = this.#entries.get(key);
		if (!plan) return null;
		this.#entries.delete(key);
		this.#entries.set(key, plan);
		return plan;
	}

	async put(key: string, plan: ReplayPlan): Promise<void> {
		this.#entries.delete(key);
		this.#entries.set(key, plan);
		while (this.#entries.size > this.#limit) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}

	async delete(key: string): Promise<void> {
		this.#entries.delete(key);
	}

	clear(): void {
		this.#entries.clear();
	}

	get size(): number {
		return this.#entries.size;
	}
}

/** Long-lived: plans change only when a render's queries do. */
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CACHE_PATH = "/_emdash/.replay-plan/";

/**
 * Workers Cache API store. Entries sit under a synthetic path on the site's
 * own origin (Cache API keys must be URLs on the zone) and carry no cache
 * tags, so content purges leave plans alone. Per data centre, like the cache
 * itself.
 */
export class CachePlanStore implements ReplayPlanStore {
	readonly #cache: Promise<Cache | null>;
	readonly #origin: string;

	constructor(cache: Promise<Cache | null> | Cache | null, origin: string) {
		this.#cache = Promise.resolve(cache);
		this.#origin = origin;
	}

	#url(key: string): string {
		return `${this.#origin}${CACHE_PATH}${encodeURIComponent(key)}`;
	}

	async get(key: string): Promise<ReplayPlan | null> {
		try {
			const cache = await this.#cache;
			const response = await cache?.match(this.#url(key));
			if (!response) return null;
			return parseReplayPlan(await response.json());
		} catch {
			return null;
		}
	}

	async put(key: string, plan: ReplayPlan): Promise<void> {
		try {
			const cache = await this.#cache;
			await cache?.put(
				this.#url(key),
				new Response(JSON.stringify(plan), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
					},
				}),
			);
		} catch {
			// Lost writes only cost a future miss.
		}
	}

	async delete(key: string): Promise<void> {
		try {
			const cache = await this.#cache;
			await cache?.delete(this.#url(key));
		} catch {
			// Best effort, as above.
		}
	}
}

/**
 * Isolate memory in front of a shared store: reads try memory first and
 * backfill it from the shared store; writes and deletes go to both.
 */
export class LayeredPlanStore implements ReplayPlanStore {
	readonly #memory: MemoryPlanStore;
	readonly #shared: ReplayPlanStore;

	constructor(memory: MemoryPlanStore, shared: ReplayPlanStore) {
		this.#memory = memory;
		this.#shared = shared;
	}

	async get(key: string): Promise<ReplayPlan | null> {
		const local = this.#memory.peek(key);
		if (local) return local;
		const plan = await this.#shared.get(key);
		if (plan) await this.#memory.put(key, plan);
		return plan;
	}

	async put(key: string, plan: ReplayPlan): Promise<void> {
		await Promise.all([this.#memory.put(key, plan), this.#shared.put(key, plan)]);
	}

	async delete(key: string): Promise<void> {
		await Promise.all([this.#memory.delete(key), this.#shared.delete(key)]);
	}
}
