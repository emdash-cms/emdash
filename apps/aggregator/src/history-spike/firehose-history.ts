import * as CAR from "@atcute/car";
import * as CBOR from "@atcute/cbor";
import * as CID from "@atcute/cid";
import type { CidLink } from "@atcute/cid";
import type { PublicKey } from "@atcute/crypto";
import { type AtprotoDid, isDid } from "@atcute/lexicons/syntax";
import { isCommit, verifyRecord } from "@atcute/repo";

export const FIREHOSE_HISTORY_SOURCE = "com.atproto.sync.subscribeRepos" as const;

export interface FirehoseRepoOp {
	action: "create" | "update" | "delete";
	cid: CidLink | null;
	path: string;
}

/** The history-bearing subset of a decoded subscribeRepos commit frame. */
export interface FirehoseCommitFrame {
	repo: string;
	seq: number;
	rev: string;
	commit: CidLink;
	blocks: CBOR.Bytes;
	ops: readonly FirehoseRepoOp[];
	tooBig: boolean;
}

export interface HistoricalRecordEvent {
	source: typeof FIREHOSE_HISTORY_SOURCE;
	did: AtprotoDid;
	sequence: number;
	operationIndex: number;
	orderingKey: readonly [sequence: number, operationIndex: number];
	rev: string;
	commitCid: string;
	collection: string;
	rkey: string;
	operation: FirehoseRepoOp["action"];
	recordCid: string | null;
	/** Event-specific commit, MST proof, and record blocks copied before enqueue. */
	carBytes: Uint8Array;
}

export interface VerifiedHistoricalRecordEvent extends HistoricalRecordEvent {
	record: unknown;
}

/**
 * Converts one relay commit frame into queue-safe, event-specific record jobs.
 * A frame can contain multiple writes, so `operationIndex` completes `seq` into
 * a total ordering and idempotency key within one relay cursor epoch.
 */
export function extractHistoricalRecordEvents(frame: FirehoseCommitFrame): HistoricalRecordEvent[] {
	if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) {
		throw new Error("firehose sequence must be a non-negative safe integer");
	}
	if (!isAtprotoDid(frame.repo))
		throw new Error(`unsupported atproto repository DID: ${frame.repo}`);
	const did = frame.repo;
	if (frame.tooBig) {
		throw new Error("tooBig firehose commits do not contain complete event-specific blocks");
	}

	const carBytes = CBOR.fromBytes(frame.blocks);
	return frame.ops.map((op, operationIndex) => {
		const separator = op.path.indexOf("/");
		if (separator <= 0 || separator === op.path.length - 1) {
			throw new Error(`invalid repository operation path: ${op.path}`);
		}
		if (op.action !== "delete" && op.cid === null) {
			throw new Error(`${op.action} operation is missing its record CID`);
		}
		if (op.action === "delete" && op.cid !== null) {
			throw new Error("delete operation unexpectedly has a record CID");
		}

		return {
			source: FIREHOSE_HISTORY_SOURCE,
			did,
			sequence: frame.seq,
			operationIndex,
			orderingKey: [frame.seq, operationIndex] as const,
			rev: frame.rev,
			commitCid: frame.commit.$link,
			collection: op.path.slice(0, separator),
			rkey: op.path.slice(separator + 1),
			operation: op.action,
			recordCid: op.cid?.$link ?? null,
			// Every job owns its proof bytes; queue delay cannot turn this into a
			// later PDS snapshot and callers cannot mutate sibling jobs in memory.
			carBytes: carBytes.slice(),
		};
	});
}

export async function verifyHistoricalRecordEvent(
	event: HistoricalRecordEvent,
	publicKey: PublicKey,
): Promise<VerifiedHistoricalRecordEvent> {
	if (event.operation === "delete") {
		throw new Error(
			"historical delete/non-inclusion proof is not implemented by the W0.6 prototype",
		);
	}

	const car = CAR.fromUint8Array(event.carBytes);
	if (car.roots.length !== 1 || car.roots[0]?.$link !== event.commitCid) {
		throw new Error("CAR root does not match the firehose commit CID");
	}

	let commitBytes: Uint8Array | undefined;
	for (const block of car) {
		const codec = block.cid.codec;
		if (codec !== CID.CODEC_DCBOR && codec !== CID.CODEC_RAW) {
			throw new Error(`unsupported CAR block codec: ${codec}`);
		}
		const actualCid = CID.toString(await CID.create(codec, Uint8Array.from(block.bytes)));
		if (CID.toString(block.cid) !== actualCid) {
			throw new Error("CAR block bytes do not match their CID");
		}
		if (actualCid === event.commitCid) commitBytes = block.bytes;
	}
	if (commitBytes === undefined) throw new Error("CAR does not contain its root commit block");

	const commit = CBOR.decode(commitBytes);
	if (!isCommit(commit)) throw new Error("CAR root is not an atproto repo commit");
	if (commit.did !== event.did) throw new Error("commit DID does not match the firehose repo");
	if (commit.rev !== event.rev) throw new Error("commit rev does not match the firehose rev");

	const verified = await verifyRecord({
		did: event.did,
		collection: event.collection,
		rkey: event.rkey,
		publicKey,
		carBytes: event.carBytes,
	});
	if (verified.cid !== event.recordCid) {
		throw new Error("verified record CID does not match the firehose operation CID");
	}

	return { ...event, record: verified.record };
}

/** Verifies, collision-checks, deduplicates, and orders one relay's delayed jobs. */
export async function recoverOrderedHistory(
	events: readonly HistoricalRecordEvent[],
	publicKey: PublicKey,
): Promise<VerifiedHistoricalRecordEvent[]> {
	const unique = new Map<string, HistoricalRecordEvent>();
	for (const event of events) {
		const key = `${event.sequence}:${event.operationIndex}`;
		const previous = unique.get(key);
		if (previous !== undefined) {
			if (!sameEvent(previous, event)) {
				throw new Error(`conflicting firehose redelivery at ${key}`);
			}
			continue;
		}
		unique.set(key, event);
	}

	const verified = await Promise.all(
		Array.from(unique.values(), (event) => verifyHistoricalRecordEvent(event, publicKey)),
	);
	verified.sort(
		(left, right) => left.sequence - right.sequence || left.operationIndex - right.operationIndex,
	);
	return verified;
}

/** Finds the profile state in force immediately before a release event. */
export function precedingProfileEvent(
	history: readonly VerifiedHistoricalRecordEvent[],
	release: VerifiedHistoricalRecordEvent,
	profileCollection: string,
	profileRkey: string,
): VerifiedHistoricalRecordEvent | undefined {
	let preceding: VerifiedHistoricalRecordEvent | undefined;
	for (const event of history) {
		if (compareOrder(event, release) >= 0) break;
		if (
			event.did === release.did &&
			event.collection === profileCollection &&
			event.rkey === profileRkey
		) {
			preceding = event;
		}
	}
	return preceding;
}

function compareOrder(left: HistoricalRecordEvent, right: HistoricalRecordEvent): number {
	return left.sequence - right.sequence || left.operationIndex - right.operationIndex;
}

function sameEvent(left: HistoricalRecordEvent, right: HistoricalRecordEvent): boolean {
	return (
		left.source === right.source &&
		left.did === right.did &&
		left.rev === right.rev &&
		left.commitCid === right.commitCid &&
		left.collection === right.collection &&
		left.rkey === right.rkey &&
		left.operation === right.operation &&
		left.recordCid === right.recordCid &&
		equalBytes(left.carBytes, right.carBytes)
	);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isAtprotoDid(value: string): value is AtprotoDid {
	return isDid(value) && (value.startsWith("did:plc:") || value.startsWith("did:web:"));
}
