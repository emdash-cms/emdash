/**
 * Label ingest DO: holds a long-lived outbound WebSocket to one labeler's
 * `subscribeLabels` stream. One instance per labeler, named by DID
 * (`env.LABEL_INGEST_DO.getByName(did)`) — see `index.ts`'s `scheduled()`.
 *
 * Unlike the records DO (a fixed singleton), this DO doesn't know its DID
 * until something tells it. The `did` isn't part of the binding name lookup
 * key material available inside the DO itself, so the first `fetch()` (the
 * cron wake, `?did=...`) supplies it; the DO persists it in its own storage
 * so later wakes/restarts don't need the query param. A DO instance that has
 * never been woken with a `did` refuses to run.
 *
 * The DO is thin by design — all the loop / verification / cursor / backoff
 * logic lives in `LabelIngestor`. The DO just wires real bindings in and
 * exposes a health check.
 */

import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import { DurableObject } from "cloudflare:workers";

import { LabelIngestor, type LabelCursorStore } from "./label-ingestor.js";
import { RealLabelStreamClient } from "./label-stream-client.js";
import { createD1LabelerIdentityCache, LabelerResolver } from "./labeler-resolver.js";
import { boundFetch } from "./utils.js";

const DID_STORAGE_KEY = "labelIngest:did";

/** D1-backed cursor store for one labeler, keyed `labeler:<did>` in the
 * shared `ingest_state` table (also used by the Jetstream cursor). Cursor is
 * stored as TEXT — `ingest_state.cursor` holds both Jetstream's microsecond
 * `time_us` and this frame `seq`, so the column stays a string for either
 * shape. */
function createD1LabelCursorStore(db: D1Database, did: string): LabelCursorStore {
	const source = `labeler:${did}`;
	return {
		async get(): Promise<number | undefined> {
			const row = await db
				.prepare(`SELECT cursor FROM ingest_state WHERE source = ?`)
				.bind(source)
				.first<{ cursor: string }>();
			if (!row) return undefined;
			const cursor = Number(row.cursor);
			return Number.isSafeInteger(cursor) ? cursor : undefined;
		},
		async put(cursor: number): Promise<void> {
			await db
				.prepare(
					`INSERT INTO ingest_state (source, cursor, updated_at)
					 VALUES (?, ?, datetime('now'))
					 ON CONFLICT(source) DO UPDATE SET
					   cursor = excluded.cursor,
					   updated_at = excluded.updated_at`,
				)
				.bind(source, String(cursor))
				.run();
		},
	};
}

export class LabelIngestDO extends DurableObject {
	private did: string | null = null;
	private ingestor: LabelIngestor | null = null;
	/** Held so the run loop isn't garbage-collected. */
	private runPromise: Promise<void> | null = null;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		// Blocks fetch() until the persisted DID (if any) is loaded, so a
		// restarted DO resumes its labeler without needing the wake request
		// to repeat `?did=`.
		state
			.blockConcurrencyWhile(async () => {
				const stored = await state.storage.get<string>(DID_STORAGE_KEY);
				if (stored) this.start(stored);
			})
			.catch((err: unknown) => {
				console.error("[aggregator] label ingest DO storage bootstrap failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	/**
	 * Health surface for the cron wake pump. `consecutiveFailures: 0` means
	 * the most recent connection attempt fully processed at least one frame;
	 * non-zero means the labeler is unreachable, its signing key can't be
	 * resolved, or every label in the current frame is failing verification.
	 */
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const requestedDid = url.searchParams.get("did");
		if (!this.did) {
			if (!requestedDid) {
				return Response.json({ error: "missing did" }, { status: 400 });
			}
			await this.ctx.storage.put(DID_STORAGE_KEY, requestedDid);
			this.start(requestedDid);
		} else if (requestedDid && requestedDid !== this.did) {
			// The DO's name is derived from `did` (`getByName(did)`), so this
			// should be unreachable in production. Log rather than crash — an
			// operational script hitting the wrong DO by hand shouldn't panic
			// an otherwise-healthy ingestor.
			console.error("[aggregator] label ingest DO wake did mismatch", {
				did: this.did,
				requestedDid,
			});
		}
		return Response.json({
			did: this.did,
			cursor: this.ingestor?.currentCursor ?? null,
			consecutiveFailures: this.ingestor?.consecutiveFailures ?? 0,
		});
	}

	private start(did: string): void {
		if (this.ingestor) return;
		this.did = did;
		const resolver = new LabelerResolver({
			cache: createD1LabelerIdentityCache(this.env.DB),
			resolver: new CompositeDidDocumentResolver({
				methods: {
					plc: new PlcDidDocumentResolver({ fetch: boundFetch }),
					web: new AtprotoWebDidDocumentResolver({ fetch: boundFetch }),
				},
			}),
		});
		this.ingestor = new LabelIngestor({
			did,
			client: new RealLabelStreamClient(),
			queue: this.env.LABELS_QUEUE,
			cursorStore: createD1LabelCursorStore(this.env.DB, did),
			resolver,
			logger: {
				warn: (msg, ctx) => console.warn(`[aggregator] ${msg}`, { did, ...ctx }),
				error: (msg, ctx) => console.error(`[aggregator] ${msg}`, { did, ...ctx }),
			},
		});
		// Fire-and-forget. The run loop absorbs every recoverable error path
		// internally (transient queue failures, connection drops, verification
		// failures all retry with backoff). The catch is here defensively — if
		// a future change introduces a non-recoverable rejection, we want it in
		// the logs rather than as an unhandled promise.
		this.runPromise = this.ingestor.run().catch((err) => {
			console.error("[aggregator] label ingestor crashed", {
				did,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}
}
