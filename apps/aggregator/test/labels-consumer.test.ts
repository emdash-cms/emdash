/**
 * Labels consumer tests.
 *
 * Runs against real D1 (workerd test pool) with real signed labels: a P-256
 * keypair via `P256PrivateKeyExportable.createKeypair()` and
 * `createLabelSigner` from `@emdash-cms/registry-moderation`, with a closure
 * `resolveDid` returning a self-consistent DID document — the same helper
 * shape as `label-ingestor.test.ts`. This exercises `parseSignedLabel` +
 * `encodeSignedLabel` for real rather than through a stub, since digest
 * identity (the whole point of this consumer) depends on canonical encoding.
 */

import { create as createCid, toString as cidToString, CODEC_RAW } from "@atcute/cid";
import { P256PrivateKeyExportable } from "@atcute/crypto";
import { toBase64Url } from "@atcute/multibase";
import {
	createLabelSigner,
	encodeSignedLabel,
	type LabelSigner,
	type SignedLabel,
	type UnsignedLabel,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { toWire, type LabelIngestJob } from "../src/label-ingest-types.js";
import {
	type ConsumerDeps,
	drainLabelsDeadLetterBatch,
	type MessageController,
	processLabelsBatch,
} from "../src/labels-consumer.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const LABELER_DID = "did:web:labeler.example";
const UNTRUSTED_LABELER_DID = "did:web:untrusted-labeler.example";
const UNKNOWN_LABELER_DID = "did:web:unknown-labeler.example";
const SUBJECT_URI = "at://did:plc:subject00000000000000000/com.example.thing/x";
const NOW = new Date("2026-07-11T12:00:00.000Z");

let signer: LabelSigner;
let untrustedSigner: LabelSigner;

async function makeSigner(issuerDid: string): Promise<LabelSigner> {
	const keypair = await P256PrivateKeyExportable.createKeypair();
	const privateKey = toBase64Url(await keypair.exportPrivateKey("raw"));
	const multikey = await keypair.exportPublicKey("multikey");
	const document = {
		id: issuerDid,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: issuerDid,
				publicKeyMultibase: multikey,
			},
		],
	};
	return createLabelSigner({ issuerDid, privateKey, resolveDid: async () => document });
}

async function makeCid(seed: string): Promise<string> {
	const encoded = new TextEncoder().encode(seed);
	const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
	bytes.set(encoded);
	const cid = await createCid(CODEC_RAW, bytes);
	return cidToString(cid);
}

async function digestOf(label: SignedLabel): Promise<string> {
	const bytes = encodeSignedLabel(label);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function labelInput(
	overrides: Partial<Omit<UnsignedLabel, "src">> = {},
): Omit<UnsignedLabel, "src"> {
	return {
		ver: 1,
		uri: SUBJECT_URI,
		val: "test-value",
		cts: "2026-07-10T12:00:00.000Z",
		...overrides,
	};
}

function jobFor(
	src: string,
	sourceSequence: number,
	frameIndex: number,
	label: SignedLabel,
): LabelIngestJob {
	return { src, sourceSequence, frameIndex, label: toWire(label) };
}

class FakeMessage implements MessageController {
	acked = 0;
	retried = 0;
	constructor(readonly body: LabelIngestJob) {}
	ack(): void {
		this.acked += 1;
	}
	retry(): void {
		this.retried += 1;
	}
}

async function runBatch(jobs: LabelIngestJob[], deps?: ConsumerDeps): Promise<FakeMessage[]> {
	const messages = jobs.map((job) => new FakeMessage(job));
	await processLabelsBatch({ messages }, { DB: testEnv.DB } as unknown as Env, deps);
	return messages;
}

async function seedLabeler(did: string, trusted: boolean): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO labelers (did, endpoint, signing_key, signing_key_id, trusted, added_at, last_resolved_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			did,
			"https://labeler.example",
			"unused-in-tests",
			`${did}#atproto_label`,
			trusted ? 1 : 0,
			NOW.toISOString(),
			NOW.toISOString(),
		)
		.run();
}

async function countRows(table: string): Promise<number> {
	const row = await testEnv.DB.prepare(`SELECT COUNT(*) as n FROM ${table}`).first<{ n: number }>();
	return row?.n ?? 0;
}

interface LabelRow {
	digest: string;
	src: string;
	uri: string;
	cid: string | null;
	val: string;
	neg: number;
	cts: string;
	cts_epoch_ms: number;
	exp: string | null;
	exp_epoch_ms: number | null;
	sig: ArrayBuffer;
	ver: number;
	source_sequence: number;
	frame_index: number;
	trusted: number;
	received_at: string;
}

interface LabelStateRow {
	src: string;
	uri: string;
	val: string;
	cid: string | null;
	neg: number;
	cts: string;
	cts_epoch_ms: number;
	exp: string | null;
	exp_epoch_ms: number | null;
	digest: string;
	source_sequence: number;
	frame_index: number;
	trusted: number;
}

async function getLabelState(src: string, uri: string, val: string): Promise<LabelStateRow | null> {
	return (
		(await testEnv.DB.prepare(`SELECT * FROM label_state WHERE src = ? AND uri = ? AND val = ?`)
			.bind(src, uri, val)
			.first<LabelStateRow>()) ?? null
	);
}

const DEPS: ConsumerDeps = { db: testEnv.DB, now: () => NOW };

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	signer = await makeSigner(LABELER_DID);
	untrustedSigner = await makeSigner(UNTRUSTED_LABELER_DID);
});

beforeEach(async () => {
	for (const table of ["labels", "label_state", "dead_letters", "labelers"]) {
		await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await seedLabeler(LABELER_DID, true);
});

describe("processLabelsBatch: happy path", () => {
	it("writes one labels row and one label_state row for a single verified label", async () => {
		const label = await signer.sign(labelInput());
		const job = jobFor(LABELER_DID, 1, 0, label);

		const [msg] = await runBatch([job], DEPS);
		expect(msg?.acked).toBe(1);
		expect(msg?.retried).toBe(0);

		const digest = await digestOf(label);
		const row = await testEnv.DB.prepare(`SELECT * FROM labels WHERE digest = ?`)
			.bind(digest)
			.first<LabelRow>();
		expect(row).toMatchObject({
			digest,
			src: LABELER_DID,
			uri: SUBJECT_URI,
			cid: null,
			val: "test-value",
			neg: 0,
			cts: "2026-07-10T12:00:00.000Z",
			cts_epoch_ms: Date.parse("2026-07-10T12:00:00.000Z"),
			exp: null,
			exp_epoch_ms: null,
			ver: 1,
			source_sequence: 1,
			frame_index: 0,
			trusted: 1,
			received_at: NOW.toISOString(),
		});
		expect(new Uint8Array(row!.sig)).toEqual(label.sig);

		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state).toMatchObject({
			digest,
			neg: 0,
			cts_epoch_ms: Date.parse("2026-07-10T12:00:00.000Z"),
			source_sequence: 1,
			frame_index: 0,
			trusted: 1,
		});
	});
});

describe("processLabelsBatch: exact redelivery", () => {
	it("is a silent no-op — acked both times, one history row, state unchanged", async () => {
		const label = await signer.sign(labelInput());
		const job = jobFor(LABELER_DID, 1, 0, label);

		const [first] = await runBatch([job], DEPS);
		expect(first?.acked).toBe(1);
		const [second] = await runBatch([job], DEPS);
		expect(second?.acked).toBe(1);
		expect(second?.retried).toBe(0);

		expect(await countRows("labels")).toBe(1);
		expect(await countRows("dead_letters")).toBe(0);
		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state).toMatchObject({ source_sequence: 1, frame_index: 0 });
	});
});

describe("processLabelsBatch: same-cts survival", () => {
	it("keeps both history rows when two different labels share (src, uri, val, cts)", async () => {
		const cts = "2026-07-10T12:00:00.000Z";
		const cidA = await makeCid("label-a");
		const cidB = await makeCid("label-b");
		const labelA = await signer.sign(labelInput({ cts, cid: cidA }));
		const labelB = await signer.sign(labelInput({ cts, cid: cidB }));
		const jobA = jobFor(LABELER_DID, 1, 0, labelA);
		const jobB = jobFor(LABELER_DID, 2, 0, labelB);

		const [msgA] = await runBatch([jobA], DEPS);
		const [msgB] = await runBatch([jobB], DEPS);
		expect(msgA?.acked).toBe(1);
		expect(msgB?.acked).toBe(1);

		expect(await countRows("labels")).toBe(2);
		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state?.digest).toBe(await digestOf(labelB));
		expect(state).toMatchObject({ source_sequence: 2, frame_index: 0, cid: cidB });
	});
});

describe("processLabelsBatch: projection ordering", () => {
	it("a newer cts replaces state", async () => {
		const older = await signer.sign(labelInput({ cts: "2026-07-10T12:00:00.000Z" }));
		const newer = await signer.sign(labelInput({ cts: "2026-07-10T13:00:00.000Z" }));
		await runBatch([jobFor(LABELER_DID, 1, 0, older)], DEPS);
		await runBatch([jobFor(LABELER_DID, 2, 0, newer)], DEPS);

		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state?.digest).toBe(await digestOf(newer));
	});

	it("an older-cts job arriving after (out-of-order delivery) leaves state at the newer event", async () => {
		const older = await signer.sign(labelInput({ cts: "2026-07-10T12:00:00.000Z" }));
		const newer = await signer.sign(labelInput({ cts: "2026-07-10T13:00:00.000Z" }));
		await runBatch([jobFor(LABELER_DID, 2, 0, newer)], DEPS);
		await runBatch([jobFor(LABELER_DID, 1, 0, older)], DEPS);

		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state?.digest).toBe(await digestOf(newer));
		expect(await countRows("labels")).toBe(2);
	});

	it("equal cts with lower coordinates does not replace state", async () => {
		const cts = "2026-07-10T12:00:00.000Z";
		const cidA = await makeCid("equal-cts-a");
		const cidB = await makeCid("equal-cts-b");
		const winner = await signer.sign(labelInput({ cts, cid: cidA }));
		const loser = await signer.sign(labelInput({ cts, cid: cidB }));
		await runBatch([jobFor(LABELER_DID, 5, 2, winner)], DEPS);
		await runBatch([jobFor(LABELER_DID, 5, 1, loser)], DEPS);

		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state?.digest).toBe(await digestOf(winner));
	});
});

describe("processLabelsBatch: negation", () => {
	it("a later neg=1 event wins state; history keeps both", async () => {
		const positive = await signer.sign(labelInput({ cts: "2026-07-10T12:00:00.000Z" }));
		const negation = await signer.sign(labelInput({ cts: "2026-07-10T13:00:00.000Z", neg: true }));
		await runBatch([jobFor(LABELER_DID, 1, 0, positive)], DEPS);
		await runBatch([jobFor(LABELER_DID, 2, 0, negation)], DEPS);

		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state).toMatchObject({ neg: 1, digest: await digestOf(negation) });
		expect(await countRows("labels")).toBe(2);
	});
});

describe("processLabelsBatch: expiry metadata", () => {
	it("stores exp/exp_epoch_ms on both tables when present", async () => {
		const label = await signer.sign(labelInput({ exp: "2027-01-01T00:00:00.000Z" }));
		await runBatch([jobFor(LABELER_DID, 1, 0, label)], DEPS);

		const digest = await digestOf(label);
		const row = await testEnv.DB.prepare(`SELECT exp, exp_epoch_ms FROM labels WHERE digest = ?`)
			.bind(digest)
			.first<{ exp: string; exp_epoch_ms: number }>();
		expect(row).toMatchObject({
			exp: "2027-01-01T00:00:00.000Z",
			exp_epoch_ms: Date.parse("2027-01-01T00:00:00.000Z"),
		});
		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state).toMatchObject({
			exp: "2027-01-01T00:00:00.000Z",
			exp_epoch_ms: Date.parse("2027-01-01T00:00:00.000Z"),
		});
	});

	it("leaves exp/exp_epoch_ms NULL when absent", async () => {
		const label = await signer.sign(labelInput());
		await runBatch([jobFor(LABELER_DID, 1, 0, label)], DEPS);

		const digest = await digestOf(label);
		const row = await testEnv.DB.prepare(`SELECT exp, exp_epoch_ms FROM labels WHERE digest = ?`)
			.bind(digest)
			.first<{ exp: string | null; exp_epoch_ms: number | null }>();
		expect(row).toMatchObject({ exp: null, exp_epoch_ms: null });
		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "test-value");
		expect(state).toMatchObject({ exp: null, exp_epoch_ms: null });
	});
});

describe("processLabelsBatch: trusted snapshot", () => {
	it("a job from an untrusted source writes trusted=0, unaffected by later flips", async () => {
		await seedLabeler(UNTRUSTED_LABELER_DID, false);
		const label = await untrustedSigner.sign(labelInput());
		await runBatch([jobFor(UNTRUSTED_LABELER_DID, 1, 0, label)], DEPS);

		const digest = await digestOf(label);
		const before = await testEnv.DB.prepare(`SELECT trusted FROM labels WHERE digest = ?`)
			.bind(digest)
			.first<{ trusted: number }>();
		expect(before?.trusted).toBe(0);
		const stateBefore = await getLabelState(UNTRUSTED_LABELER_DID, SUBJECT_URI, "test-value");
		expect(stateBefore?.trusted).toBe(0);

		await testEnv.DB.prepare(`UPDATE labelers SET trusted = 1 WHERE did = ?`)
			.bind(UNTRUSTED_LABELER_DID)
			.run();

		const after = await testEnv.DB.prepare(`SELECT trusted FROM labels WHERE digest = ?`)
			.bind(digest)
			.first<{ trusted: number }>();
		expect(after?.trusted).toBe(0);
		const stateAfter = await getLabelState(UNTRUSTED_LABELER_DID, SUBJECT_URI, "test-value");
		expect(stateAfter?.trusted).toBe(0);
	});
});

describe("processLabelsBatch: LABEL_UNKNOWN_SOURCE", () => {
	it("dead-letters a job whose src has no labelers row, acks, writes nothing else", async () => {
		const orphanSigner = await makeSigner(UNKNOWN_LABELER_DID);
		const label = await orphanSigner.sign(labelInput());
		const [msg] = await runBatch([jobFor(UNKNOWN_LABELER_DID, 1, 0, label)], DEPS);

		expect(msg?.acked).toBe(1);
		expect(msg?.retried).toBe(0);
		expect(await countRows("labels")).toBe(0);
		expect(await countRows("label_state")).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT reason, did FROM dead_letters`).first<{
			reason: string;
			did: string;
		}>();
		expect(dl).toMatchObject({ reason: "LABEL_UNKNOWN_SOURCE", did: UNKNOWN_LABELER_DID });
	});
});

describe("processLabelsBatch: LABEL_INVALID", () => {
	it("dead-letters a structurally broken wire label, acks, writes nothing else", async () => {
		const label = await signer.sign(labelInput());
		const wire = toWire(label);
		const job: LabelIngestJob = {
			src: LABELER_DID,
			sourceSequence: 1,
			frameIndex: 0,
			label: { ...wire, val: "" }, // empty val fails validateLabelValue
		};

		const [msg] = await runBatch([job], DEPS);
		expect(msg?.acked).toBe(1);
		expect(msg?.retried).toBe(0);
		expect(await countRows("labels")).toBe(0);
		expect(await countRows("label_state")).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters`).first<{
			reason: string;
		}>();
		expect(dl?.reason).toBe("LABEL_INVALID");
	});
});

describe("processLabelsBatch: src mismatch", () => {
	it("dead-letters a job whose src differs from the signed label's src", async () => {
		await seedLabeler(UNTRUSTED_LABELER_DID, false);
		const label = await untrustedSigner.sign(labelInput());
		const [msg] = await runBatch([jobFor(LABELER_DID, 1, 0, label)], DEPS);

		expect(msg?.acked).toBe(1);
		expect(msg?.retried).toBe(0);
		expect(await countRows("labels")).toBe(0);
		expect(await countRows("label_state")).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters`).first<{
			reason: string;
		}>();
		expect(dl?.reason).toBe("LABEL_INVALID");
	});
});

describe("processLabelsBatch: LABEL_COORDINATE_CONFLICT", () => {
	it("a second, different label at the same coordinates dead-letters; first survives unaffected", async () => {
		const first = await signer.sign(labelInput({ val: "value-a" }));
		const second = await signer.sign(labelInput({ val: "value-b" }));
		const jobFirst = jobFor(LABELER_DID, 9, 3, first);
		const jobSecond = jobFor(LABELER_DID, 9, 3, second);

		const [msg1] = await runBatch([jobFirst], DEPS);
		expect(msg1?.acked).toBe(1);
		const [msg2] = await runBatch([jobSecond], DEPS);
		expect(msg2?.acked).toBe(1);
		expect(msg2?.retried).toBe(0);

		expect(await countRows("labels")).toBe(1);
		const digestFirst = await digestOf(first);
		const row = await testEnv.DB.prepare(`SELECT digest FROM labels`).first<{ digest: string }>();
		expect(row?.digest).toBe(digestFirst);

		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters`).first<{
			reason: string;
		}>();
		expect(dl?.reason).toBe("LABEL_COORDINATE_CONFLICT");

		// No state row for the second label's val — its batch rolled back entirely.
		const stateSecond = await getLabelState(LABELER_DID, SUBJECT_URI, "value-b");
		expect(stateSecond).toBeNull();
		const stateFirst = await getLabelState(LABELER_DID, SUBJECT_URI, "value-a");
		expect(stateFirst?.digest).toBe(digestFirst);
	});
});

describe("processLabelsBatch: cursor-0 replay idempotency", () => {
	it("replaying an identical mixed batch leaves history count and state identical", async () => {
		const cidC = await makeCid("replay-c");
		const labels = await Promise.all([
			signer.sign(labelInput({ val: "v1", cts: "2026-07-10T12:00:00.000Z" })),
			signer.sign(labelInput({ val: "v2", cts: "2026-07-10T12:05:00.000Z" })),
			signer.sign(labelInput({ val: "v3", cts: "2026-07-10T12:10:00.000Z", neg: true })),
			signer.sign(
				labelInput({ val: "v4", cts: "2026-07-10T12:15:00.000Z", exp: "2027-01-01T00:00:00.000Z" }),
			),
			signer.sign(labelInput({ val: "v5", cts: "2026-07-10T12:20:00.000Z", cid: cidC })),
		]);
		const jobs = labels.map((label, i) => jobFor(LABELER_DID, 100 + i, 0, label));

		await runBatch(jobs, DEPS);
		const historyBefore = await countRows("labels");
		const statesBefore = await testEnv.DB.prepare(
			`SELECT src, uri, val, digest, cts_epoch_ms, source_sequence, frame_index, trusted
			 FROM label_state ORDER BY val`,
		).all();

		// Replay the identical set in a fresh batch (simulates cursor-0 rebuild).
		await runBatch(jobs, DEPS);
		const historyAfter = await countRows("labels");
		const statesAfter = await testEnv.DB.prepare(
			`SELECT src, uri, val, digest, cts_epoch_ms, source_sequence, frame_index, trusted
			 FROM label_state ORDER BY val`,
		).all();

		expect(historyAfter).toBe(historyBefore);
		expect(historyBefore).toBe(5);
		expect(statesAfter.results).toEqual(statesBefore.results);
	});
});

describe("processLabelsBatch: per-message isolation", () => {
	it("a valid job lands while an invalid job in the same batch dead-letters; both ack", async () => {
		const valid = await signer.sign(labelInput({ val: "valid-value" }));
		const validJob = jobFor(LABELER_DID, 1, 0, valid);
		const invalidWire = toWire(await signer.sign(labelInput({ val: "invalid-value" })));
		const invalidJob: LabelIngestJob = {
			src: LABELER_DID,
			sourceSequence: 1,
			frameIndex: 1,
			label: { ...invalidWire, val: "" },
		};

		const [msgValid, msgInvalid] = await runBatch([validJob, invalidJob], DEPS);
		expect(msgValid?.acked).toBe(1);
		expect(msgInvalid?.acked).toBe(1);

		expect(await countRows("labels")).toBe(1);
		const state = await getLabelState(LABELER_DID, SUBJECT_URI, "valid-value");
		expect(state).not.toBeNull();
		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters`).first<{
			reason: string;
		}>();
		expect(dl?.reason).toBe("LABEL_INVALID");
	});
});

describe("processLabelsBatch: transient D1 failure", () => {
	it("retries when db.batch() throws a non-constraint error", async () => {
		const label = await signer.sign(labelInput());
		const job = jobFor(LABELER_DID, 1, 0, label);

		const failingDb = {
			prepare: () => ({
				bind: () => ({
					first: () => Promise.resolve({ trusted: 1 }),
					run: () => Promise.resolve({ meta: { changes: 1 } }),
				}),
			}),
			batch: () => Promise.reject(new Error("D1 unavailable")),
		} as unknown as D1Database;

		const [msg] = await runBatch([job], { db: failingDb, now: () => NOW });
		expect(msg?.retried).toBe(1);
		expect(msg?.acked).toBe(0);
	});
});

describe("drainLabelsDeadLetterBatch", () => {
	it("acks each message and writes a forensics row", async () => {
		const label = await signer.sign(labelInput());
		const job = jobFor(LABELER_DID, 1, 0, label);
		const message = new FakeMessage(job);

		await drainLabelsDeadLetterBatch({ messages: [message] }, { DB: testEnv.DB } as unknown as Env);

		expect(message.acked).toBe(1);
		expect(await countRows("dead_letters")).toBe(1);
		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters`).first<{
			reason: string;
		}>();
		expect(dl?.reason).toBe("LABEL_UNEXPECTED_ERROR");
	});

	it("retries the message when writeDeadLetter throws", async () => {
		const label = await signer.sign(labelInput());
		const job = jobFor(LABELER_DID, 1, 0, label);
		const message = new FakeMessage(job);
		const failingDb = {
			prepare: () => ({
				bind: () => ({
					run: () => Promise.reject(new Error("D1 unavailable")),
				}),
			}),
		} as unknown as D1Database;

		await drainLabelsDeadLetterBatch({ messages: [message] }, { DB: failingDb } as unknown as Env);

		expect(message.retried).toBe(1);
		expect(message.acked).toBe(0);
	});
});
