import {
	encodeSignedListingLabel,
	isVerifiedListingLabel,
	type SignedListingLabel,
	type VerifiedListingLabel,
} from "@emdash-cms/registry-moderation";

import { persistedInstant } from "./label-state.js";
import { readProjectionWork } from "./projection-work.js";

const MAX_LABELS_PER_BATCH = 20;

export interface AcceptedListingLabel {
	signed: SignedListingLabel;
	verified: VerifiedListingLabel;
}

export interface AcceptListingLabelsInput {
	db: D1Database;
	source: string;
	labels: readonly AcceptedListingLabel[];
	sourceSequence?: number;
	cursor?: number;
	receivedAt?: Date;
	trusted?: boolean;
}

export interface AcceptListingLabelsResult {
	projectionSchedulingPending: boolean;
}

export async function acceptListingLabels(
	input: AcceptListingLabelsInput,
): Promise<AcceptListingLabelsResult> {
	if (input.labels.length === 0) {
		if (input.cursor !== undefined) {
			throw new TypeError("a label cursor cannot advance without durably accepted labels");
		}
		return {
			projectionSchedulingPending: (await readProjectionWork(input.db)).schedulingPending,
		};
	}
	const prepared = await Promise.all(
		input.labels.map(async (entry, frameIndex) => prepare(entry, input.source, frameIndex)),
	);
	const receivedAt = (input.receivedAt ?? new Date()).toISOString();

	for (let offset = 0; offset < prepared.length; offset += MAX_LABELS_PER_BATCH) {
		const chunk = prepared.slice(offset, offset + MAX_LABELS_PER_BATCH);
		const finalChunk = offset + chunk.length === prepared.length;
		const statements: D1PreparedStatement[] = [];
		for (let index = 0; index < chunk.length; index++) {
			const event = chunk[index]!;
			statements.push(
				historyStatement(input.db, event, receivedAt),
				...(input.sourceSequence === undefined
					? []
					: [
							coordinateStatement(
								input.db,
								input.source,
								input.sourceSequence,
								offset + index,
								event.historyDigest,
							),
						]),
				expiryStatement(input.db, event),
				stateStatement(
					input.db,
					event,
					input.sourceSequence ?? null,
					offset + index,
					input.trusted ?? true,
				),
			);
		}
		if (finalChunk && input.cursor !== undefined) {
			statements.push(cursorStatement(input.db, input.source, input.cursor));
		}
		await input.db.batch(statements);
	}
	return {
		projectionSchedulingPending: (await readProjectionWork(input.db)).schedulingPending,
	};
}

interface PreparedLabel extends AcceptedListingLabel {
	historyDigest: string;
	stateDigest: string;
	ctsEpoch: number;
	ctsFraction: string;
	expEpoch: number | null;
}

async function prepare(
	entry: AcceptedListingLabel,
	expectedSource: string,
	_frameIndex: number,
): Promise<PreparedLabel> {
	if (!isVerifiedListingLabel(entry.verified)) {
		throw new TypeError("label must be verified before persistence");
	}
	if (entry.verified.src !== expectedSource || entry.signed.src !== expectedSource) {
		throw new TypeError("label source does not match accepted source");
	}
	const cts = persistedInstant(entry.verified.cts, "label.cts");
	const exp =
		entry.verified.exp === undefined ? null : persistedInstant(entry.verified.exp, "label.exp");
	const [historyDigest, stateDigest] = await Promise.all([
		digest(encodeSignedListingLabel(entry.signed)),
		digest(
			new TextEncoder().encode(
				JSON.stringify([
					entry.verified.ver,
					entry.verified.src,
					entry.verified.uri,
					entry.verified.cid ?? null,
					entry.verified.val,
					entry.verified.neg === true,
					entry.verified.cts,
					entry.verified.exp ?? null,
				]),
			),
		),
	]);
	return {
		...entry,
		historyDigest,
		stateDigest,
		ctsEpoch: cts.epoch,
		ctsFraction: cts.fraction,
		expEpoch: exp?.epoch ?? null,
	};
}

function historyStatement(
	db: D1Database,
	event: PreparedLabel,
	receivedAt: string,
): D1PreparedStatement {
	const label = event.verified;
	return db
		.prepare(
			`INSERT INTO listing_labels
			   (digest, state_digest, src, uri, cid, val, neg, cts, cts_epoch, cts_fraction,
			    exp, exp_epoch, sig, ver, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(digest) DO NOTHING`,
		)
		.bind(
			event.historyDigest,
			event.stateDigest,
			label.src,
			label.uri,
			label.cid ?? null,
			label.val,
			label.neg === true ? 1 : 0,
			label.cts,
			event.ctsEpoch,
			event.ctsFraction,
			label.exp ?? null,
			event.expEpoch,
			event.signed.sig,
			label.ver,
			receivedAt,
		);
}

function coordinateStatement(
	db: D1Database,
	source: string,
	sequence: number,
	frameIndex: number,
	historyDigest: string,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO listing_label_stream_coordinates
			   (src, source_sequence, frame_index, digest)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(src, source_sequence, frame_index) DO UPDATE SET
			   digest = excluded.digest`,
		)
		.bind(source, sequence, frameIndex, historyDigest);
}

function expiryStatement(db: D1Database, event: PreparedLabel): D1PreparedStatement {
	const label = event.verified;
	return db
		.prepare(
			`INSERT INTO listing_label_state_expiry (src, uri, val, exp, exp_epoch)
			 SELECT ?, ?, ?, ?, ?
			 WHERE NOT EXISTS (
			   SELECT 1 FROM label_state current
			   WHERE current.src = ? AND current.uri = ? AND current.val = ?
			     AND current.cts_epoch IS NOT NULL
			     AND (current.cts_epoch > ? OR
			       (current.cts_epoch = ? AND current.cts_fraction > ?))
			 )
			 ON CONFLICT(src, uri, val) DO UPDATE SET
			   exp = excluded.exp, exp_epoch = excluded.exp_epoch`,
		)
		.bind(
			label.src,
			label.uri,
			label.val,
			label.exp ?? null,
			event.expEpoch,
			label.src,
			label.uri,
			label.val,
			event.ctsEpoch,
			event.ctsEpoch,
			event.ctsFraction,
		);
}

function stateStatement(
	db: D1Database,
	event: PreparedLabel,
	sequence: number | null,
	frameIndex: number,
	trusted: boolean,
): D1PreparedStatement {
	const label = event.verified;
	return db
		.prepare(
			`INSERT INTO label_state
			   (src, uri, val, cid, neg, cts, exp, trusted, cts_epoch,
			    cts_fraction, digest, source_sequence, frame_index, collision)
			 VALUES (?, ?, ?, ?, ?, ?, ?,
			   CASE WHEN ? = 1 AND EXISTS (
			     SELECT 1 FROM labellers source
			     WHERE source.did = ? AND source.active = 1 AND source.trusted = 1
			   ) THEN 1 ELSE 0 END,
			   ?, ?, ?, ?, ?, 0)
			 ON CONFLICT(src, uri, val) DO UPDATE SET
			   cid = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.cid ELSE label_state.cid END,
			   neg = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.neg ELSE label_state.neg END,
			   cts = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.cts ELSE label_state.cts END,
			   exp = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.exp ELSE label_state.exp END,
			   trusted = excluded.trusted,
			   cts_epoch = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.cts_epoch ELSE label_state.cts_epoch END,
			   cts_fraction = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.cts_fraction ELSE label_state.cts_fraction END,
			   digest = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.digest ELSE label_state.digest END,
			   source_sequence = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.source_sequence ELSE label_state.source_sequence END,
			   frame_index = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
			     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			     OR label_state.cts_epoch IS NULL THEN excluded.frame_index ELSE label_state.frame_index END,
			   collision = CASE
			     WHEN excluded.cts_epoch > label_state.cts_epoch OR
			       (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
			       OR label_state.cts_epoch IS NULL THEN 0
			     WHEN excluded.cts_epoch = label_state.cts_epoch
			       AND excluded.cts_fraction = label_state.cts_fraction
			       AND excluded.digest <> label_state.digest THEN 1
			     ELSE label_state.collision END
			 WHERE label_state.cts_epoch IS NULL
			    OR excluded.cts_epoch > label_state.cts_epoch
			    OR (excluded.cts_epoch = label_state.cts_epoch
			      AND excluded.cts_fraction > label_state.cts_fraction)
			    OR (excluded.cts_epoch = label_state.cts_epoch
			      AND excluded.cts_fraction = label_state.cts_fraction
			      AND excluded.digest <> label_state.digest)`,
		)
		.bind(
			label.src,
			label.uri,
			label.val,
			label.cid ?? null,
			label.neg === true ? 1 : 0,
			label.cts,
			label.exp ?? null,
			trusted ? 1 : 0,
			label.src,
			event.ctsEpoch,
			event.ctsFraction,
			event.stateDigest,
			sequence,
			frameIndex,
		);
}

function cursorStatement(db: D1Database, source: string, cursor: number): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO ingest_state (source, cursor, updated_at)
			 VALUES (?, ?, datetime('now'))
			 ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor,
			   updated_at = excluded.updated_at
			 WHERE CAST(excluded.cursor AS INTEGER) > CAST(ingest_state.cursor AS INTEGER)`,
		)
		.bind(`labeler:${source}`, String(cursor));
}

async function digest(bytes: Uint8Array): Promise<string> {
	const digestBytes = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

export async function readLabelCursor(db: D1Database, source: string): Promise<number> {
	const row = await db
		.prepare(`SELECT cursor FROM ingest_state WHERE source = ?`)
		.bind(`labeler:${source}`)
		.first<{ cursor: string }>();
	if (!row) return 0;
	const cursor = Number(row.cursor);
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new Error("stored label cursor is invalid");
	}
	return cursor;
}
