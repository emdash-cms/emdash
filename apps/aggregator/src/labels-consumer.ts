/**
 * Labels queue consumer. Writes append-only history (`labels`) plus a
 * current-state projection (`label_state`) for every verified signed label
 * enqueued by `LabelIngestor` (`label-ingestor.ts`).
 *
 * For each `LabelIngestJob`:
 *
 *   1. `fromWire` + `parseSignedLabel` revalidate the payload (defense in
 *      depth — the queue payload is internal, but the parse is cheap).
 *   2. Compute the SHA-256 digest of `encodeSignedLabel(label)`. This is the
 *      `labels` primary key, so exact redelivery (same signed bytes) is a
 *      silent no-op via `ON CONFLICT(digest) DO NOTHING`.
 *   3. Look up `labelers.trusted` for `job.src` (cached per batch) and snapshot
 *      it onto the written rows as receipt-time provenance.
 *   4. One `db.batch()` writes the history row and conditionally upserts
 *      `label_state`, keyed by `(src, uri, val)`, keeping only the winner by
 *      `(cts_epoch_ms, source_sequence, frame_index)`.
 *
 * Error policy:
 *   - Structurally invalid wire payload: `dead_letters` row (`LABEL_INVALID`),
 *     ack. Never retry — the bytes won't parse differently next time.
 *   - `src` absent from `labelers`: `dead_letters` row
 *     (`LABEL_UNKNOWN_SOURCE`), ack. The ingestor only subscribes to
 *     configured labelers, so this indicates the row was removed between
 *     subscribe and delivery.
 *   - A different signed label landing at coordinates
 *     `(src, source_sequence, frame_index)` already occupied by another
 *     label: `dead_letters` row (`LABEL_COORDINATE_CONFLICT`), ack. This is a
 *     permanent conflict — the labeler is replaying its stream inconsistently.
 *   - Any other D1 failure: `retry()`.
 */

import {
	encodeSignedLabel,
	parseSignedLabel,
	type SignedLabel,
} from "@emdash-cms/registry-moderation";

import { fromWire, type LabelIngestJob } from "./label-ingest-types.js";

/** Deps the consumer needs at runtime. Tests inject their own `db` (and
 * optionally `now`) to run against a real D1 instance without a live queue. */
export interface ConsumerDeps {
	db: D1Database;
	now?: () => Date;
}

/** Subset of `cloudflare:workers` `Message` we use; defining inline so tests
 * don't need to import workerd types. */
export interface MessageController {
	ack(): void;
	retry(): void;
}

/** Subset of a `MessageBatch`. Workers' real batch object satisfies this. */
export interface MessageBatchLike<T> {
	readonly messages: ReadonlyArray<MessageController & { body: T }>;
}

/** Reason codes written to `dead_letters.reason` for labels jobs. */
export type LabelDeadLetterReason =
	| "LABEL_INVALID"
	| "LABEL_UNKNOWN_SOURCE"
	| "LABEL_COORDINATE_CONFLICT"
	| "LABEL_UNEXPECTED_ERROR";

/** `dead_letters.collection` value for labels jobs — the table is shared with
 * the records consumer, which stores an actual NSID there; labels jobs have
 * no NSID, so this is a fixed tag identifying the ingest pipeline. */
const LABEL_DEAD_LETTER_COLLECTION = "com.atproto.label.subscribeLabels";

export async function processLabelsBatch(
	batch: MessageBatchLike<LabelIngestJob>,
	env: Env,
	depsOverride?: ConsumerDeps,
): Promise<void> {
	const deps = depsOverride ?? { db: env.DB };
	// Cached across the whole batch: labelers rarely change mid-batch, and a
	// lookup per message would otherwise cost one D1 round trip per label.
	const trustedCache = new Map<string, boolean | null>();
	// Process jobs independently — see records-consumer.ts's processBatch for
	// why the try/catch has to wrap each message rather than the loop.
	for (const message of batch.messages) {
		try {
			await processLabelMessage(message.body, message, deps, trustedCache);
		} catch (err) {
			console.error("[aggregator] processLabelMessage threw unexpectedly", {
				src: message.body.src,
				sourceSequence: message.body.sourceSequence,
				frameIndex: message.body.frameIndex,
				error: err instanceof Error ? err.message : String(err),
			});
			message.retry();
		}
	}
}

/**
 * Drain the labels DLQ. Same "log + ack" policy as `drainDeadLetterBatch` in
 * records-consumer.ts: record the job to Workers logs and `dead_letters`, ack
 * so the DLQ doesn't grow unbounded.
 */
export async function drainLabelsDeadLetterBatch(
	batch: MessageBatchLike<LabelIngestJob>,
	env: Env,
): Promise<void> {
	const now = new Date();
	for (const message of batch.messages) {
		const job = message.body;
		console.warn("[aggregator] labels DLQ drain: acking job", {
			src: job.src,
			sourceSequence: job.sourceSequence,
			frameIndex: job.frameIndex,
		});
		try {
			await writeDeadLetter(env.DB, job, "LABEL_UNEXPECTED_ERROR", "drained from DLQ", now);
			message.ack();
		} catch (err) {
			console.error("[aggregator] labels DLQ drain: failed to write forensics row, retrying", {
				src: job.src,
				error: err instanceof Error ? err.message : String(err),
			});
			message.retry();
		}
	}
}

async function processLabelMessage(
	job: LabelIngestJob,
	controller: MessageController,
	deps: ConsumerDeps,
	trustedCache: Map<string, boolean | null>,
): Promise<void> {
	const now = deps.now ?? (() => new Date());

	let label: SignedLabel;
	try {
		label = parseSignedLabel(fromWire(job.label));
	} catch (err) {
		await writeDeadLetter(
			deps.db,
			job,
			"LABEL_INVALID",
			err instanceof Error ? err.message : String(err),
			now(),
		);
		controller.ack();
		return;
	}

	if (label.src !== job.src) {
		// The ingestor enqueues job.src = verified label.src, so a mismatch means
		// the job did not come from our producer. The digest and the (src, ...)
		// row keys would disagree about which labeler signed these bytes.
		await writeDeadLetter(
			deps.db,
			job,
			"LABEL_INVALID",
			`label src '${label.src}' does not match job src '${job.src}'`,
			now(),
		);
		controller.ack();
		return;
	}

	const trusted = await lookupTrusted(deps.db, job.src, trustedCache);
	if (trusted === null) {
		await writeDeadLetter(
			deps.db,
			job,
			"LABEL_UNKNOWN_SOURCE",
			`no labelers row for src '${job.src}'`,
			now(),
		);
		controller.ack();
		return;
	}

	const digest = await digestSignedLabel(label);
	const ctsEpochMs = Date.parse(label.cts);
	const expEpochMs = label.exp === undefined ? null : Date.parse(label.exp);

	try {
		await deps.db.batch([
			insertLabelStmt(deps.db, job, label, digest, ctsEpochMs, expEpochMs, trusted, now()),
			upsertLabelStateStmt(deps.db, job, label, digest, ctsEpochMs, expEpochMs, trusted),
		]);
	} catch (err) {
		if (isCoordinateConflict(err)) {
			await writeDeadLetter(
				deps.db,
				job,
				"LABEL_COORDINATE_CONFLICT",
				`a different label already occupies (src=${job.src}, source_sequence=${job.sourceSequence}, frame_index=${job.frameIndex})`,
				now(),
			);
			controller.ack();
			return;
		}
		console.error("[aggregator] labels batch write failed", {
			src: job.src,
			sourceSequence: job.sourceSequence,
			frameIndex: job.frameIndex,
			error: err instanceof Error ? err.message : String(err),
		});
		controller.retry();
		return;
	}

	controller.ack();
}

async function lookupTrusted(
	db: D1Database,
	src: string,
	cache: Map<string, boolean | null>,
): Promise<boolean | null> {
	const cached = cache.get(src);
	if (cached !== undefined) return cached;
	const row = await db
		.prepare(`SELECT trusted FROM labelers WHERE did = ?`)
		.bind(src)
		.first<{ trusted: number }>();
	const trusted = row ? row.trusted === 1 : null;
	cache.set(src, trusted);
	return trusted;
}

async function digestSignedLabel(label: SignedLabel): Promise<string> {
	const bytes = encodeSignedLabel(label);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(new Uint8Array(hash));
}

const HEX_ALPHABET = "0123456789abcdef";
function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) {
		out += HEX_ALPHABET[byte >> 4];
		out += HEX_ALPHABET[byte & 0x0f];
	}
	return out;
}

function insertLabelStmt(
	db: D1Database,
	job: LabelIngestJob,
	label: SignedLabel,
	digest: string,
	ctsEpochMs: number,
	expEpochMs: number | null,
	trusted: boolean,
	receivedAt: Date,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO labels
			   (digest, src, uri, cid, val, neg, cts, cts_epoch_ms, exp, exp_epoch_ms,
			    sig, ver, source_sequence, frame_index, trusted, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(digest) DO NOTHING`,
		)
		.bind(
			digest,
			job.src,
			label.uri,
			label.cid ?? null,
			label.val,
			label.neg === true ? 1 : 0,
			label.cts,
			ctsEpochMs,
			label.exp ?? null,
			expEpochMs,
			label.sig,
			label.ver,
			job.sourceSequence,
			job.frameIndex,
			trusted ? 1 : 0,
			receivedAt.toISOString(),
		);
}

function upsertLabelStateStmt(
	db: D1Database,
	job: LabelIngestJob,
	label: SignedLabel,
	digest: string,
	ctsEpochMs: number,
	expEpochMs: number | null,
	trusted: boolean,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO label_state
			   (src, uri, val, cid, neg, cts, cts_epoch_ms, exp, exp_epoch_ms,
			    digest, source_sequence, frame_index, trusted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(src, uri, val) DO UPDATE SET
			   cid = excluded.cid,
			   neg = excluded.neg,
			   cts = excluded.cts,
			   cts_epoch_ms = excluded.cts_epoch_ms,
			   exp = excluded.exp,
			   exp_epoch_ms = excluded.exp_epoch_ms,
			   digest = excluded.digest,
			   source_sequence = excluded.source_sequence,
			   frame_index = excluded.frame_index,
			   trusted = excluded.trusted
			 WHERE excluded.cts_epoch_ms > label_state.cts_epoch_ms
			    OR (excluded.cts_epoch_ms = label_state.cts_epoch_ms
			        AND (excluded.source_sequence > label_state.source_sequence
			             OR (excluded.source_sequence = label_state.source_sequence
			                 AND excluded.frame_index > label_state.frame_index)))`,
		)
		.bind(
			job.src,
			label.uri,
			label.val,
			label.cid ?? null,
			label.neg === true ? 1 : 0,
			label.cts,
			ctsEpochMs,
			label.exp ?? null,
			expEpochMs,
			digest,
			job.sourceSequence,
			job.frameIndex,
			trusted ? 1 : 0,
		);
}

/**
 * Distinguishes the `UNIQUE (src, source_sequence, frame_index)` conflict
 * from any other D1 failure. The `labels` INSERT already resolves a digest
 * (primary key) conflict via `ON CONFLICT(digest) DO NOTHING`, so the only
 * constraint violation that can still reach here is the coordinate index —
 * D1 doesn't surface a structured error code, so the column names in
 * SQLite's message text are the only reliable signal.
 */
function isCoordinateConflict(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return (
		err.message.includes("UNIQUE constraint failed") &&
		err.message.includes("labels.source_sequence") &&
		err.message.includes("labels.frame_index")
	);
}

async function writeDeadLetter(
	db: D1Database,
	job: LabelIngestJob,
	reason: LabelDeadLetterReason,
	detail: string | null,
	now: Date,
): Promise<void> {
	const payloadBytes = new TextEncoder().encode(JSON.stringify(job.label));
	await db
		.prepare(
			`INSERT INTO dead_letters
			   (did, collection, rkey, reason, detail, payload, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			job.src,
			LABEL_DEAD_LETTER_COLLECTION,
			`${job.sourceSequence}:${job.frameIndex}`,
			reason,
			detail,
			payloadBytes,
			now.toISOString(),
		)
		.run();
}
