/**
 * In-memory atproto repo with real signing.
 *
 * Wraps `@atproto/repo`'s `Repo` + `MemoryBlockstore` so a test publisher can
 * append signed writes that round-trip through any spec-compliant verifier.
 * The aggregator's verification path uses `@atcute/repo`'s `verifyRecord`
 * against the same byte format.
 *
 * Why @atproto/repo (heavyweight) instead of building from @atcute primitives:
 * the production aggregator uses @atcute everywhere because of bundle size
 * and Workers compatibility, but for test fixtures we want the canonical
 * reference implementation so any divergence between our mocks and a real
 * PDS is the test's problem, not the mock's.
 */

import { P256Keypair, parseDidKey, type Keypair } from "@atproto/crypto";
import {
	MemoryBlockstore,
	Repo,
	WriteOpAction,
	blocksToCarFile,
	getRecords,
	type RecordCreateOp,
	type RecordPath,
} from "@atproto/repo";

import type { AtprotoDid } from "./types.js";

export interface FakeRepoOptions {
	did: AtprotoDid;
	keypair?: Keypair;
}

interface StoredRecord {
	collection: string;
	rkey: string;
	value: unknown;
}

export class FakeRepo {
	readonly did: AtprotoDid;
	readonly keypair: Keypair;
	readonly storage: MemoryBlockstore;
	private repo: Repo;
	/** Parallel index for listRecords; the repo blockstore can answer this too,
	 * but iterating it here would require walking the MST per call. */
	private records = new Map<string, StoredRecord>();

	private constructor(did: AtprotoDid, keypair: Keypair, storage: MemoryBlockstore, repo: Repo) {
		this.did = did;
		this.keypair = keypair;
		this.storage = storage;
		this.repo = repo;
	}

	static async create(options: FakeRepoOptions): Promise<FakeRepo> {
		const keypair = options.keypair ?? (await P256Keypair.create({ exportable: true }));
		const storage = new MemoryBlockstore();
		const repo = await Repo.create(storage, options.did, keypair);
		return new FakeRepo(options.did, keypair, storage, repo);
	}

	/**
	 * The publisher's `did:key` representation. The aggregator will resolve the
	 * publisher's DID document and read this from the `#atproto` verification
	 * method; tests call this directly to construct a DID document for the
	 * MockDidResolver.
	 */
	didKey(): string {
		return this.keypair.did();
	}

	/**
	 * Raw public key bytes. Useful when constructing an `@atcute/crypto`
	 * `PublicKey` for direct verification (bypassing DID resolution).
	 */
	async publicKeyBytes(): Promise<{ bytes: Uint8Array; jwtAlg: string }> {
		const parsed = parseDidKey(this.didKey());
		return { bytes: parsed.keyBytes, jwtAlg: parsed.jwtAlg };
	}

	/**
	 * Append a single create. Re-signs the commit. Subsequent calls form a
	 * normal repo history (each commit's `prev` points at the previous
	 * commit's CID).
	 */
	async putRecord(collection: string, rkey: string, value: Record<string, unknown>): Promise<void> {
		// @atproto/repo types `collection` as `NsidString` and `record` as
		// `LexMap`. Tests pass plain string + Record<string, unknown> for
		// ergonomics; the underlying CBOR encode + signing path doesn't care
		// about the lexicon-validation type narrowings, so we cast at the
		// boundary rather than forcing every test to import branded types.
		const op = {
			action: WriteOpAction.Create,
			collection,
			rkey,
			record: value,
		} as unknown as RecordCreateOp;
		this.repo = await this.repo.applyWrites(op, this.keypair);
		this.records.set(`${collection}/${rkey}`, { collection, rkey, value });
	}

	/**
	 * Update an existing record. Re-signs the commit. The aggregator's
	 * verification tests use this to model a profile update flow.
	 */
	async updateRecord(
		collection: string,
		rkey: string,
		value: Record<string, unknown>,
	): Promise<void> {
		const op = {
			action: WriteOpAction.Update,
			collection,
			rkey,
			record: value,
		} as unknown as RecordCreateOp;
		this.repo = await this.repo.applyWrites(op, this.keypair);
		this.records.set(`${collection}/${rkey}`, { collection, rkey, value });
	}

	/**
	 * Delete a record. Re-signs the commit. The aggregator's verification
	 * tests use this to model the publisher-deleted-the-record path that
	 * triggers tombstoning in D1.
	 */
	async deleteRecord(collection: string, rkey: string): Promise<void> {
		const op = {
			action: WriteOpAction.Delete,
			collection,
			rkey,
		} as unknown as RecordCreateOp;
		this.repo = await this.repo.applyWrites(op, this.keypair);
		this.records.delete(`${collection}/${rkey}`);
	}

	/**
	 * Returns the CAR bytes for `com.atproto.sync.getRecord`: the latest signed
	 * commit + MST proof down to the record + the record block. The verifier
	 * walks this exact shape.
	 */
	async getRecordCar(collection: string, rkey: string): Promise<Uint8Array> {
		const head = await this.storage.getRoot();
		if (!head) throw new Error("repo has no root commit");
		const path: RecordPath = { collection, rkey };
		const chunks: Uint8Array[] = [];
		for await (const chunk of getRecords(this.storage, head, [path])) {
			chunks.push(chunk);
		}
		return concatBytes(chunks);
	}

	/**
	 * Returns the full repo as a CAR. Used for `com.atproto.sync.getRepo` and
	 * by reconciliation flows that want to verify the entire repo at once.
	 * Not used by the verification path today, but it's a one-liner that
	 * matches a real PDS endpoint, so we expose it for future tests.
	 */
	async getFullRepoCar(): Promise<Uint8Array> {
		const head = await this.storage.getRoot();
		if (!head) throw new Error("repo has no root commit");
		const blocks = await this.storage.getBlocks([head]);
		return blocksToCarFile(head, blocks.blocks);
	}

	/**
	 * `com.atproto.repo.listRecords` shape. Returns every record in a
	 * collection, in insertion order. The real PDS sorts by rkey descending
	 * by default; the aggregator's reconciliation pass doesn't depend on
	 * order, so insertion order is fine.
	 */
	listRecords(collection: string): Array<{ uri: string; value: unknown }> {
		const items: Array<{ uri: string; value: unknown }> = [];
		for (const r of this.records.values()) {
			if (r.collection !== collection) continue;
			items.push({ uri: `at://${this.did}/${r.collection}/${r.rkey}`, value: r.value });
		}
		return items;
	}

	/** Snapshot of a single record value, no MST proof. */
	getRecordValue(collection: string, rkey: string): unknown {
		return this.records.get(`${collection}/${rkey}`)?.value;
	}
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}
