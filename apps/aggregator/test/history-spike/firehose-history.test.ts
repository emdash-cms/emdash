import * as CAR from "@atcute/car";
import * as CBOR from "@atcute/cbor";
import * as CID from "@atcute/cid";
import { P256PrivateKeyExportable } from "@atcute/crypto";
import { buildInclusionProof, MemoryBlockStore, NodeStore, NodeWrangler } from "@atcute/mst";
import { PROFILE_NSID, RELEASE_NSID } from "@emdash-cms/atproto-test-utils/nsid";
import { describe, expect, it } from "vitest";

import {
	extractHistoricalRecordEvents,
	precedingProfileEvent,
	recoverOrderedHistory,
	verifyHistoricalRecordEvent,
	type FirehoseCommitFrame,
	type HistoricalRecordEvent,
} from "../../src/history-spike/firehose-history.js";

const DID = "did:plc:history000000000000000000";
const SLUG = "history-plugin";

describe("subscribeRepos historical input", () => {
	it("recovers strict -> relaxed -> release -> strict after delayed, reordered delivery", async () => {
		const repo = await SignedRepoFixture.create(DID);
		const strictBefore = await repo.write(101, "create", PROFILE_NSID, SLUG, profile("strict"));
		const relaxed = await repo.write(102, "update", PROFILE_NSID, SLUG, profile("relaxed"));
		const release = await repo.write(103, "create", RELEASE_NSID, `${SLUG}:1.0.0`, {
			$type: RELEASE_NSID,
			package: SLUG,
			version: "1.0.0",
		});
		const strictAfter = await repo.write(104, "update", PROFILE_NSID, SLUG, profile("strict"));

		// Nothing is processed until every write has happened. Queue arrival is
		// deliberately reversed and the relaxed event is redelivered from a
		// separately deserialized queue value with byte-equal proof contents.
		const relaxedRedelivery = cloneEvent(relaxed);
		expect(relaxedRedelivery).not.toBe(relaxed);
		expect(relaxedRedelivery.carBytes).not.toBe(relaxed.carBytes);
		expect(relaxedRedelivery.carBytes).toEqual(relaxed.carBytes);
		const delayedQueue = [strictAfter, release, relaxed, strictBefore, relaxedRedelivery];
		const history = await recoverOrderedHistory(delayedQueue, repo.keypair);

		expect(history.map((event) => event.orderingKey)).toEqual([
			[101, 0],
			[102, 0],
			[103, 0],
			[104, 0],
		]);
		const profiles = history.filter((event) => event.collection === PROFILE_NSID);
		expect(profiles.map((event) => (event.record as { policy: string }).policy)).toEqual([
			"strict",
			"relaxed",
			"strict",
		]);
		// Identical strict values have the same content CID, but remain distinct
		// events because commit CID, rev, and source ordering are retained.
		expect(profiles[0]?.recordCid).toBe(profiles[2]?.recordCid);
		expect(profiles[0]?.commitCid).not.toBe(profiles[2]?.commitCid);
		expect(profiles[0]?.rev).not.toBe(profiles[2]?.rev);

		const recoveredRelease = history.find((event) => event.collection === RELEASE_NSID);
		expect(recoveredRelease).toBeDefined();
		const policyAtPublication = precedingProfileEvent(
			history,
			recoveredRelease!,
			PROFILE_NSID,
			SLUG,
		);
		expect(policyAtPublication?.sequence).toBe(102);
		if (policyAtPublication === undefined) throw new Error("preceding profile was not recovered");
		expect((policyAtPublication.record as { policy: string }).policy).toBe("relaxed");

		for (const event of history) {
			expect(event.recordCid).toMatch(/^b/);
			expect(event.commitCid).toMatch(/^b/);
			expect(event.rev).toMatch(/^3/);
			expect(event.carBytes.byteLength).toBeGreaterThan(0);
		}
	});

	it("proves a current-record fetch cannot recover the intermediate profile", async () => {
		const repo = await SignedRepoFixture.create(DID);
		await repo.write(201, "create", PROFILE_NSID, SLUG, profile("strict"));
		const relaxed = await repo.write(202, "update", PROFILE_NSID, SLUG, profile("relaxed"));
		const finalStrict = await repo.write(203, "update", PROFILE_NSID, SLUG, profile("strict"));

		const historical = await verifyHistoricalRecordEvent(relaxed, repo.keypair);
		const current = await verifyHistoricalRecordEvent(finalStrict, repo.keypair);

		expect((historical.record as { policy: string }).policy).toBe("relaxed");
		expect((current.record as { policy: string }).policy).toBe("strict");
		expect(current.recordCid).not.toBe(historical.recordCid);
		// A delayed com.atproto.sync.getRecord request would return only this
		// final proof. The relaxed proof survives solely in the queued frame CAR.
		expect(repo.currentRecordCid(PROFILE_NSID, SLUG)).toBe(current.recordCid);
	});

	it("rejects metadata substitution instead of trusting record JSON", async () => {
		const repo = await SignedRepoFixture.create(DID);
		const event = await repo.write(301, "create", PROFILE_NSID, SLUG, profile("strict"));

		await expect(
			verifyHistoricalRecordEvent({ ...event, rev: "3mismatchedrev" }, repo.keypair),
		).rejects.toThrow("commit rev does not match");
		await expect(
			verifyHistoricalRecordEvent({ ...event, recordCid: event.commitCid }, repo.keypair),
		).rejects.toThrow("record CID does not match");

		const tampered = event.carBytes.slice();
		const finalByteIndex = tampered.length - 1;
		tampered[finalByteIndex]! ^= 1;
		await expect(
			verifyHistoricalRecordEvent({ ...event, carBytes: tampered }, repo.keypair),
		).rejects.toThrow();
	});

	it("rejects a commit signed by a different DID key", async () => {
		const repo = await SignedRepoFixture.create(DID);
		const event = await repo.write(351, "create", PROFILE_NSID, SLUG, profile("strict"));
		const unrelatedKey = await P256PrivateKeyExportable.createKeypair();

		await expect(verifyHistoricalRecordEvent(event, unrelatedKey)).rejects.toThrow(
			"signature verification failed",
		);
	});

	it("retains delete events but fails closed without a historical non-inclusion proof", async () => {
		const repo = await SignedRepoFixture.create(DID);
		const prior = await repo.write(375, "create", PROFILE_NSID, SLUG, profile("strict"));
		const [deleted] = extractHistoricalRecordEvents({
			repo: prior.did,
			seq: 376,
			rev: prior.rev,
			commit: { $link: prior.commitCid },
			blocks: CBOR.toBytes(prior.carBytes),
			ops: [{ action: "delete", cid: null, path: `${PROFILE_NSID}/${SLUG}` }],
			tooBig: false,
		});

		expect(deleted).toMatchObject({ operation: "delete", recordCid: null, sequence: 376 });
		await expect(recoverOrderedHistory([deleted!], repo.keypair)).rejects.toThrow(
			"historical delete/non-inclusion proof is not implemented",
		);
	});

	it("rejects a conflicting redelivery at the same single-relay ordering key", async () => {
		const repo = await SignedRepoFixture.create(DID);
		const event = await repo.write(401, "create", PROFILE_NSID, SLUG, profile("strict"));
		const conflicting = cloneEvent(event);
		const finalByteIndex = conflicting.carBytes.length - 1;
		conflicting.carBytes[finalByteIndex]! ^= 1;

		await expect(recoverOrderedHistory([event, conflicting], repo.keypair)).rejects.toThrow(
			"conflicting firehose redelivery at 401:0",
		);
	});
});

function profile(policy: "strict" | "relaxed"): Record<string, unknown> {
	return { $type: PROFILE_NSID, slug: SLUG, policy };
}

function cloneEvent(event: HistoricalRecordEvent): HistoricalRecordEvent {
	return {
		...event,
		orderingKey: [event.sequence, event.operationIndex],
		carBytes: event.carBytes.slice(),
	};
}

class SignedRepoFixture {
	readonly keypair: P256PrivateKeyExportable;
	private readonly store = new MemoryBlockStore();
	private readonly nodeStore = new NodeStore(this.store);
	private readonly wrangler = new NodeWrangler(this.nodeStore);
	private readonly records = new Map<string, string>();
	private rootCid: string | null = null;
	private commitCid: string | null = null;

	private constructor(
		private readonly did: string,
		keypair: P256PrivateKeyExportable,
	) {
		this.keypair = keypair;
	}

	static async create(did: string): Promise<SignedRepoFixture> {
		return new SignedRepoFixture(did, await P256PrivateKeyExportable.createKeypair());
	}

	currentRecordCid(collection: string, rkey: string): string | undefined {
		return this.records.get(`${collection}/${rkey}`);
	}

	async write(
		sequence: number,
		action: "create" | "update",
		collection: string,
		rkey: string,
		record: Record<string, unknown>,
	): Promise<HistoricalRecordEvent> {
		const path = `${collection}/${rkey}`;
		const recordBytes = CBOR.encode(record);
		const recordCid = await CID.create(CID.CODEC_DCBOR, recordBytes);
		const recordLink = CID.toCidLink(recordCid);
		await this.store.put(CID.toString(recordCid), recordBytes);
		this.rootCid = await this.wrangler.putRecord(this.rootCid, path, recordLink);
		this.records.set(path, recordLink.$link);

		const rev = revision(sequence);
		const unsignedCommit = {
			version: 3 as const,
			did: this.did,
			data: { $link: this.rootCid },
			rev,
			prev: this.commitCid === null ? null : { $link: this.commitCid },
		};
		const signature = await this.keypair.sign(CBOR.encode(unsignedCommit));
		const commitBytes = CBOR.encode({ ...unsignedCommit, sig: CBOR.toBytes(signature) });
		const commitCid = await CID.create(CID.CODEC_DCBOR, commitBytes);
		this.commitCid = CID.toString(commitCid);
		await this.store.put(this.commitCid, commitBytes);

		const proofCids = await buildInclusionProof(this.nodeStore, this.rootCid, path);
		const blockCids = [this.commitCid, ...proofCids, recordLink.$link];
		const blocks = await Promise.all(
			blockCids.map(async (cid) => {
				const bytes = await this.store.get(cid);
				if (bytes === null) throw new Error(`fixture block missing: ${cid}`);
				return { cid: CID.fromString(cid).bytes, data: bytes };
			}),
		);
		const carChunks: Uint8Array[] = [];
		for await (const chunk of CAR.writeCarStream([{ $link: this.commitCid }], blocks)) {
			carChunks.push(chunk);
		}
		const carBytes = concat(carChunks);
		const frame: FirehoseCommitFrame = {
			repo: this.did,
			seq: sequence,
			rev,
			commit: { $link: this.commitCid },
			blocks: CBOR.toBytes(carBytes),
			ops: [{ action, cid: recordLink, path }],
			tooBig: false,
		};
		return extractHistoricalRecordEvents(frame)[0]!;
	}
}

function revision(sequence: number): string {
	return `3${sequence.toString(32).padStart(12, "2")}`;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}
