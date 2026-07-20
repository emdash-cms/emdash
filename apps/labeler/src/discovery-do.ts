/**
 * Discovery Jetstream DO: holds a long-lived outbound WebSocket to
 * Jetstream, filters for release records, and enqueues discovery jobs onto
 * the discovery queue (spec §9.1).
 *
 * Same rationale as the aggregator's `RecordsJetstreamDO` for using a DO at
 * all — outbound WebSockets stay open across requests, but a Worker isolate
 * doesn't, and a DO instance keeps the connection alive continuously. The
 * DO is thin by design; all loop/cursor/backoff logic lives in
 * `JetstreamIngestor`.
 *
 * Unlike the aggregator, the cursor is D1-backed (`ingest_state`, decision:
 * D1-visible cursors match the aggregator-ingest precedent) rather than DO
 * storage — an operator can inspect `SELECT * FROM ingest_state` on either
 * service the same way.
 */

import { DurableObject } from "cloudflare:workers";

import { RealJetstreamClient } from "./jetstream-client.js";
import { JetstreamIngestor, type IngestorStorage } from "./jetstream-ingestor.js";

/** Singleton DO ID. There's exactly one discovery ingestor per deployment. */
export const LABELER_DISCOVERY_DO_NAME = "main";

const INGEST_SOURCE = "jetstream";

/**
 * D1-backed cursor store, `ingest_state` row keyed `source = 'jetstream'`.
 * `key` is ignored — the ingestor only ever calls this with its own
 * constant storage key, and this store has exactly one row to track.
 */
function createD1IngestorStorage(db: D1Database): IngestorStorage {
	return {
		async get(): Promise<number | undefined> {
			const row = await db
				.prepare(`SELECT cursor FROM ingest_state WHERE source = ?`)
				.bind(INGEST_SOURCE)
				.first<{ cursor: string }>();
			if (!row) return undefined;
			const cursor = Number(row.cursor);
			return Number.isSafeInteger(cursor) ? cursor : undefined;
		},
		async put(_key: string, value: number): Promise<void> {
			await db
				.prepare(
					`INSERT INTO ingest_state (source, cursor, updated_at)
					 VALUES (?, ?, datetime('now'))
					 ON CONFLICT(source) DO UPDATE SET
					   cursor = excluded.cursor,
					   updated_at = excluded.updated_at`,
				)
				.bind(INGEST_SOURCE, String(value))
				.run();
		},
	};
}

export class LabelerDiscoveryDO extends DurableObject {
	private readonly ingestor: JetstreamIngestor;
	/** Held so the run loop isn't garbage-collected. */
	private readonly runPromise: Promise<void>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.ingestor = new JetstreamIngestor({
			client: new RealJetstreamClient(env.JETSTREAM_URL),
			queue: env.DISCOVERY_QUEUE,
			storage: createD1IngestorStorage(env.DB),
		});
		// Fire-and-forget. The run loop absorbs every recoverable error path
		// internally (transient queue failures, connection drops, parse
		// errors all retry with backoff). The catch is here defensively — if
		// a future change introduces a non-recoverable rejection, we want it
		// in the logs rather than as an unhandled promise.
		this.runPromise = this.ingestor.run().catch((err) => {
			console.error("[labeler] discovery jetstream ingestor crashed", err);
		});
	}

	/**
	 * Status surface for the 5-minute cron liveness pump. `0` means the
	 * most recent connection attempt produced at least one event; non-zero
	 * indicates Jetstream is unreachable or the wantedCollections filter is
	 * mismatched.
	 */
	override async fetch(_request: Request): Promise<Response> {
		return Response.json({
			cursor: this.ingestor.currentCursor,
			consecutiveFailures: this.ingestor.consecutiveFailures,
		});
	}
}
