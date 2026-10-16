import type { PluginContext, StorageCollection } from "emdash";

import type { Config } from "./config.js";
import { documentKey, type SearchDocument } from "./documents.js";
import type { ItemState } from "./ingestion.js";
import {
	clearSnapshot,
	type IndexedItem,
	saveSnapshot,
	SNAPSHOT,
	type SnapshotRow,
	type SnapshotStore,
	toIndexedItem,
} from "./snapshot.js";
import {
	type Plan,
	type RecordSource,
	recordSource,
	SourceCache,
	type SourceDeps,
} from "./sources.js";
import { isWarmingUp } from "./warm-up.js";

export type { Exclusion, Plan } from "./sources.js";

const PAGE_SIZE = 50;

/** Records synced at once. Each one waits on several AI Search and database calls. */
const CONCURRENCY = 10;

/** Writes a sync makes after its first to follow a record that keeps changing. */
const MAX_RECHECKS = 3;

export interface IndexerDeps extends SourceDeps {
	items: Pick<AiSearchItems, "list" | "upload" | "delete">;
	snapshot: SnapshotStore;
	/** Whether the instance was created recently enough that AI Search may not serve it yet. */
	warmingUp?: () => Promise<boolean>;
}

export interface SyncResult {
	/** Ids of the records synced. */
	synced: string[];
	/** Records sent to AI Search, as opposed to unchanged or removed ones. */
	uploaded: number;
	/** Records that could not be synced, not counting those stopped by a rate limit. */
	failures: Failure[];
	/** AI Search refused an upload for sending too many; the rest of the batch was not attempted. */
	backOff: boolean;
}

type Outcome = "uploaded" | "unchanged" | "removed";

export interface Failure {
	id: string;
	error: string;
	/** The state of the item AI Search still holds for the record, if any. */
	leftover?: ItemState;
}

export interface PageResult extends SyncResult {
	/** Cursor of the next page, or undefined after the last one. */
	cursor?: string;
}

/**
 * Keeps AI Search items in step with EmDash records. AI Search holds the only
 * lasting copy of indexed state: each item's metadata carries a hash of the
 * document it was built from, so unchanged records are never re-uploaded.
 */
export class Indexer {
	private readonly cache: SourceCache;
	private readonly sources = new Map<string, RecordSource>();

	constructor(
		private readonly deps: IndexerDeps,
		readonly config: Config,
	) {
		this.cache = new SourceCache(deps);
	}

	static fromContext(ctx: PluginContext, instance: AiSearchInstance, config: Config): Indexer {
		const snapshot = ctx.storage[SNAPSHOT] as StorageCollection<SnapshotRow>;
		return new Indexer(
			{ ...emdashAccess(ctx), items: instance.items, snapshot, warmingUp: () => isWarmingUp(ctx) },
			config,
		);
	}

	/**
	 * Reads one page of a source's AI Search items into the snapshot that
	 * `syncPage` compares against, starting over at page 1. `next` is the next
	 * page, or undefined after the last.
	 */
	async snapshotPage(source: string, page: number): Promise<{ next?: number; backOff: boolean }> {
		if (page === 1) await clearSnapshot(this.deps.snapshot, source);
		let result: AiSearchItemInfo[];
		try {
			({ result } = await this.aiSearch(() =>
				this.deps.items.list({
					metadata_filter: JSON.stringify({ folder: `${source}/` }),
					sort_by: "modified_at",
					per_page: PAGE_SIZE,
					page,
				}),
			));
		} catch (error) {
			if (shouldBackOff(error)) return { backOff: true };
			throw error;
		}
		await saveSnapshot(this.deps.snapshot, source, result);
		return { next: result.length === PAGE_SIZE ? page + 1 : undefined, backOff: false };
	}

	/**
	 * Syncs one page of a source's records against the source's snapshot, and
	 * removes their rows from it. Rows left after the last page belong to items
	 * no record claimed, including every item of a disabled source; `sweepPage`
	 * handles those.
	 */
	async syncPage(source: string, cursor: string | undefined): Promise<PageResult> {
		const config = this.config.sources[source];
		if (!config?.enabled) return { synced: [], uploaded: 0, failures: [], backOff: false };
		const records = this.source(source);
		const page = await records.list(PAGE_SIZE, cursor);
		const [planner, snapshot] = await Promise.all([
			records.planner(page.items, config),
			this.deps.snapshot.getMany(
				page.items.map((record) => documentKey(source, records.idOf(record))),
			),
		]);
		const result = await this.reconcile(
			source,
			page.items.map((record) => ({ id: records.idOf(record), plan: () => planner.plan(record) })),
			snapshot,
		);
		return { ...result, cursor: page.cursor };
	}

	/**
	 * Syncs a page of the source's items that no record claimed during the
	 * build: those of unpublished, deleted, or disabled records, and of records
	 * that changed state after the build passed them. Returns `done` once none
	 * are left.
	 */
	async sweepPage(source: string): Promise<SyncResult & { done: boolean }> {
		const { items: rows } = await this.deps.snapshot.query({
			where: { source },
			limit: PAGE_SIZE,
		});
		if (rows.length === 0)
			return { synced: [], uploaded: 0, failures: [], backOff: false, done: true };
		const result = await this.reconcile(
			source,
			rows.map((row) => {
				const id = recordIdOf(source, row.id);
				return { id, plan: () => this.plan(source, id) };
			}),
			new Map(rows.map((row) => [row.id, row.data])),
		);
		return { ...result, done: false };
	}

	/** Indexes or removes one record according to its current state. Throws if that fails. */
	async syncRecord(source: string, id: string): Promise<void> {
		await this.apply(source, id, await this.plan(source, id));
	}

	/** The document a record should have in AI Search, or why it should have none. */
	async plan(source: string, id: string): Promise<Plan> {
		const config = this.config.sources[source];
		if (!config?.enabled) return "disabled";
		const records = this.source(source);
		const record = await records.get(id);
		if (!record) return "deleted";
		return (await records.planner([record], config)).plan(record);
	}

	/** The AI Search item holding a record, if any. */
	async indexedItem(source: string, id: string): Promise<AiSearchItemInfo | null> {
		return this.find(documentKey(source, id));
	}

	/** A record's display title, or null when it no longer exists. */
	async describeRecord(source: string, id: string): Promise<string | null> {
		const records = this.source(source);
		const record = await records.get(id);
		return record ? records.titleOf(record) : null;
	}

	private source(id: string): RecordSource {
		let source = this.sources.get(id);
		if (!source) {
			source = recordSource(this.deps, id, this.cache);
			this.sources.set(id, source);
		}
		return source;
	}

	/**
	 * Drops records' rows from the source's snapshot. A build calls this for a
	 * page's failures once they are queued for retry, so a page whose failures
	 * could not be queued finds them again when it runs again.
	 */
	async forget(source: string, ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.deps.snapshot.deleteMany(ids.map((id) => documentKey(source, id)));
	}

	/**
	 * Applies each record's plan, then drops the snapshot rows of the records
	 * synced. After a rate limit the caller retries the same records, so only
	 * the rows of removed items go: the rest still describe what AI Search holds.
	 * Rows of failed records stay until the caller `forget`s them.
	 */
	private async reconcile(
		source: string,
		records: Array<{ id: string; plan: () => Promise<Plan> }>,
		snapshot: Map<string, IndexedItem>,
	): Promise<SyncResult> {
		const { removed, ...result } = await settle(
			records,
			(record) => record.id,
			async (record) => this.apply(source, record.id, await record.plan(), snapshot),
		);
		await this.forget(source, result.backOff ? removed : result.synced);
		return result;
	}

	/** Uploads the planned document, or removes the record's item. */
	private async apply(
		source: string,
		id: string,
		plan: Plan,
		snapshot?: Map<string, IndexedItem>,
	): Promise<Outcome> {
		if (typeof plan === "string") {
			if (plan === "no-url")
				console.warn(`[ai-search] ${source}/${id} has no public URL; not indexed`);
			const item = await this.existing(documentKey(source, id), snapshot);
			if (!item) return "unchanged";
			await this.write(item, () => this.deps.items.delete(item.itemId));
			await this.recheck(source, id, null);
			return "removed";
		}
		const existing = await this.existing(plan.key, snapshot);
		if (existing && !existing.failed && existing.hash === plan.metadata.hash) {
			return "unchanged";
		}
		const item = await this.upload(plan, existing);
		// A rate-limited page runs again; its snapshot must not send this record again.
		if (snapshot) await saveSnapshot(this.deps.snapshot, source, [item]);
		await this.recheck(source, id, { document: plan, item });
		return "uploaded";
	}

	/**
	 * Applies the record's current plan for as long as it keeps changing while
	 * the previous write was in flight. A hook for the change may already have
	 * run and found nothing to update, so otherwise the older state would stay
	 * in search. Throws once the record has changed `MAX_RECHECKS` times, so the
	 * caller queues it for retry.
	 */
	private async recheck(
		source: string,
		id: string,
		written: { document: SearchDocument; item: AiSearchItemInfo } | null,
	): Promise<void> {
		for (let rewrites = 0; ; rewrites++) {
			// oxlint-disable-next-line no-await-in-loop -- each check follows the previous write
			const latest = await this.plan(source, id);
			const settled =
				typeof latest === "string"
					? !written
					: latest.metadata.hash === written?.document.metadata.hash;
			if (settled) return;
			const current = written ? toIndexedItem(written.item) : null;
			if (rewrites === MAX_RECHECKS) {
				throw new WriteError(
					new Error("The record kept changing while it was synced"),
					current?.state,
				);
			}
			if (typeof latest !== "string") {
				// oxlint-disable-next-line no-await-in-loop -- each write follows the previous check
				written = { document: latest, item: await this.upload(latest, current) };
			} else if (written) {
				const { item } = written;
				// oxlint-disable-next-line no-await-in-loop -- each write follows the previous check
				await this.write(current, () => this.deps.items.delete(item.id));
				written = null;
			}
		}
	}

	private async upload(
		document: SearchDocument,
		existing: IndexedItem | null,
	): Promise<AiSearchItemInfo> {
		// AI Search rejects non-string values, even for fields declared as number or datetime.
		const metadata = Object.fromEntries(
			Object.entries(document.metadata).map(([name, value]) => [name, String(value)]),
		);
		return this.write(existing, () =>
			this.deps.items.upload(document.key, document.body, { metadata }),
		);
	}

	/** Runs an upload or removal, recording on failure what AI Search still holds for the record. */
	private async write<T>(existing: IndexedItem | null, call: () => Promise<T>): Promise<T> {
		try {
			return await this.aiSearch(call);
		} catch (error) {
			if (shouldBackOff(error)) throw error;
			throw new WriteError(error, existing?.state);
		}
	}

	private async existing(
		key: string,
		snapshot: Map<string, IndexedItem> | undefined,
	): Promise<IndexedItem | null> {
		if (snapshot) return snapshot.get(key) ?? null;
		const item = await this.find(key);
		return item ? toIndexedItem(item) : null;
	}

	/** Runs an AI Search call, reporting "not found" from an instance that is still starting as a reason to back off. */
	private async aiSearch<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (isInstanceNotFound(error) && (await this.deps.warmingUp?.())) {
				throw new InstanceStartingError();
			}
			throw error;
		}
	}

	private async find(key: string): Promise<AiSearchItemInfo | null> {
		const { result } = await this.aiSearch(() => this.deps.items.list({ key }));
		return result[0] ?? null;
	}
}

/** The record id in an item key made by `documentKey`. */
function recordIdOf(source: string, key: string): string {
	return key.slice(source.length + 1, -".md".length);
}

/**
 * Runs `sync` over `records` a few at a time, collecting failures instead of
 * stopping at the first. Stops starting new records once AI Search rate-limits.
 */
async function settle<T>(
	records: T[],
	idOf: (record: T) => string,
	sync: (record: T) => Promise<Outcome>,
): Promise<SyncResult & { removed: string[] }> {
	const result = {
		synced: [] as string[],
		uploaded: 0,
		removed: [] as string[],
		failures: [] as SyncResult["failures"],
		backOff: false,
	};
	let next = 0;
	const worker = async () => {
		while (next < records.length && !result.backOff) {
			const record = records[next++] as T;
			try {
				const outcome = await sync(record);
				if (outcome === "uploaded") result.uploaded++;
				if (outcome === "removed") result.removed.push(idOf(record));
				result.synced.push(idOf(record));
			} catch (error) {
				if (shouldBackOff(error)) {
					result.backOff = true;
					continue;
				}
				console.error("[ai-search] sync failed:", error);
				result.failures.push({ id: idOf(record), ...failureOf(error) });
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length) }, worker));
	return result;
}

const RATE_LIMIT_MESSAGE = /rate limit/i;
const NOT_FOUND_MESSAGE = /ai_search_not_found/;

/** AI Search does not serve a newly created instance for its first few seconds. */
class InstanceStartingError extends Error {
	constructor() {
		super("AI Search is still starting the instance");
	}
}

/** An upload or removal AI Search refused, with the state of the item it still holds for the record. */
class WriteError extends Error {
	constructor(
		error: unknown,
		readonly leftover: ItemState | undefined,
	) {
		super(errorText(error), { cause: error });
	}
}

/** What to record about a failed sync. */
export function failureOf(error: unknown): Omit<Failure, "id"> {
	const leftover = error instanceof WriteError ? error.leftover : undefined;
	return { error: errorText(error), ...(leftover ? { leftover } : {}) };
}

function isInstanceNotFound(error: unknown): boolean {
	return error instanceof Error && NOT_FOUND_MESSAGE.test(error.message);
}

/** AI Search refused the call for now: it is rate-limiting, or still starting the instance. */
export function shouldBackOff(error: unknown): boolean {
	return (
		error instanceof InstanceStartingError ||
		(error instanceof Error && RATE_LIMIT_MESSAGE.test(error.message))
	);
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The EmDash read access the plugin declares as capabilities. */
export function emdashAccess(ctx: PluginContext): SourceDeps {
	const { content, schema, bylines, media, taxonomies } = ctx;
	if (!content || !schema || !bylines || !media || !taxonomies) {
		throw new Error(
			"[ai-search] missing content, schema, bylines, media, or taxonomies read capability",
		);
	}
	return { content, schema, bylines, media, taxonomies };
}
