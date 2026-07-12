import { CODEC_RAW, create as createCid, toString as cidToString } from "@atcute/cid";
import {
	createLabelSigner,
	verifyLabel,
	type LabelDidDocument,
	type LabelSigner,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	automatedIdempotencyKey,
	computeRunKey,
	initialTriggerId,
} from "../src/assessment-lifecycle.js";
import { getAssessmentByRunKey, getCurrentAssessment } from "../src/assessment-store.js";
import {
	type DiscoveryConsumerDeps,
	type MessageController,
	processDiscoveryMessage,
} from "../src/discovery-consumer.js";
import type { DiscoveryJob } from "../src/env.js";
import { PdsVerificationError, type VerifiedPdsRecord } from "../src/pds-verify.js";
import { MODERATION_POLICY } from "../src/policy.js";
import {
	RecordVerificationError,
	type DidDocumentResolverLike,
} from "../src/record-verification.js";
import { issueAutomatedAssessmentLabel } from "../src/service.js";
import { initializeSigningState } from "../src/signing-rotation.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";
const config = { labelerDid: LABELER_DID, signingKeyVersion: "v1" };
let releaseCounter = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	await initializeSigningState(testEnv.DB, {
		issuerDid: LABELER_DID,
		keyVersion: "v1",
		publicKeyMultibase: MULTIKEY,
	});
});

function document(): LabelDidDocument {
	return {
		id: LABELER_DID,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: LABELER_DID,
				publicKeyMultibase: MULTIKEY,
			},
		],
	};
}

async function signer(): Promise<LabelSigner> {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(),
	});
}

function rkey(name?: string): string {
	releaseCounter++;
	return `${name ?? `pkg-${releaseCounter}`}:1.0.0`;
}

async function cid(seed: string): Promise<string> {
	const bytes = new TextEncoder().encode(seed);
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const value = await createCid(CODEC_RAW, new Uint8Array(buffer));
	return cidToString(value);
}

async function jobFor(overrides: Partial<DiscoveryJob> & { rkey: string }): Promise<DiscoveryJob> {
	return {
		did: PUBLISHER_DID,
		collection: RELEASE_COLLECTION,
		operation: "create",
		cid: overrides.cid ?? (await cid(overrides.rkey)),
		...overrides,
	};
}

function uriFor(job: DiscoveryJob): string {
	return `at://${job.did}/${job.collection}/${job.rkey}`;
}

class StubResolver implements DidDocumentResolverLike {
	resolve(): never {
		throw new Error("StubResolver should not be called — inject `verify` instead");
	}
}

class FakeMessage implements MessageController {
	acked = 0;
	retried = 0;
	ack() {
		this.acked += 1;
	}
	retry() {
		this.retried += 1;
	}
}

async function buildDeps(): Promise<DiscoveryConsumerDeps> {
	return {
		db: testEnv.DB,
		config,
		signer: await signer(),
		didDocumentResolver: new StubResolver(),
	};
}

function verifiedFor(job: DiscoveryJob): () => Promise<VerifiedPdsRecord> {
	return () =>
		Promise.resolve({
			cid: job.cid,
			record: { $type: RELEASE_COLLECTION, package: job.rkey.split(":")[0], version: "1.0.0" },
			carBytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
		});
}

async function runKeyFor(job: DiscoveryJob): Promise<string> {
	return computeRunKey({
		uri: uriFor(job),
		cid: job.cid,
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: "unassigned",
		promptHash: "unassigned",
		scannerSetVersion: "unassigned",
		triggerId: initialTriggerId(job.cid),
	});
}

describe("processDiscoveryMessage: verified create", () => {
	it("creates a verified subject, a pending run, and issues a real signed assessment-pending label", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, { ...deps, verify: verifiedFor(job) });

		expect(msg.acked).toBe(1);
		expect(msg.retried).toBe(0);

		const subject = await testEnv.DB.prepare(
			`SELECT uri, cid, deleted_at FROM subjects WHERE uri = ?`,
		)
			.bind(uriFor(job))
			.first<{ uri: string; cid: string; deleted_at: string | null }>();
		expect(subject).toMatchObject({ uri: uriFor(job), cid: job.cid, deleted_at: null });

		const runKey = await runKeyFor(job);
		const assessment = await getAssessmentByRunKey(testEnv.DB, runKey);
		expect(assessment?.state).toBe("pending");
		expect(assessment?.trigger).toBe("initial");

		const labelRow = await testEnv.DB.prepare(
			`SELECT l.val, l.neg, l.src, l.uri, l.cid FROM issued_labels l
			 JOIN issuance_actions a ON a.id = l.action_id
			 WHERE a.assessment_id = ?`,
		)
			.bind(assessment!.id)
			.first<{ val: string; neg: number; src: string; uri: string; cid: string }>();
		expect(labelRow).toMatchObject({
			val: "assessment-pending",
			neg: 0,
			src: LABELER_DID,
			uri: uriFor(job),
			cid: job.cid,
		});

		// Replay the same idempotent issuance to get back a fully-typed
		// `IssuedLabel` (exercises the same idempotent-replay path
		// `automated-issuance.test.ts` already covers) and assert its
		// signature verifies — not just that a DB row exists.
		const idempotencyKey = automatedIdempotencyKey(runKey, "assessment-pending", false);
		const replay = await issueAutomatedAssessmentLabel(
			testEnv.DB,
			config,
			await signer(),
			{
				actor: LABELER_DID,
				type: "automated-assessment",
				assessmentId: assessment!.id,
				reason: "initial discovery",
				idempotencyKey,
			},
			{ uri: uriFor(job), cid: job.cid, val: "assessment-pending" },
		);
		await expect(
			verifyLabel({ label: replay.label, resolveDid: async () => document() }),
		).resolves.toMatchObject({ src: LABELER_DID, uri: uriFor(job), val: "assessment-pending" });
	});

	it("redelivery converges: same runKey, same idempotency, exactly one label", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();

		await processDiscoveryMessage(job, new FakeMessage(), { ...deps, verify: verifiedFor(job) });
		await processDiscoveryMessage(job, new FakeMessage(), { ...deps, verify: verifiedFor(job) });

		const runKey = await runKeyFor(job);
		const assessments = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM assessments WHERE run_key = ?`,
		)
			.bind(runKey)
			.first<{ n: number }>();
		expect(assessments?.n).toBe(1);

		const labels = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ? AND val = 'assessment-pending'`,
		)
			.bind(uriFor(job))
			.first<{ n: number }>();
		expect(labels?.n).toBe(1);
	});

	it("update event for a new CID creates a distinct subject and run", async () => {
		const name = rkey();
		const deps = await buildDeps();
		const jobV1 = await jobFor({ rkey: name, cid: await cid(`${name}-v1`) });
		const jobV2 = { ...jobV1, operation: "update" as const, cid: await cid(`${name}-v2`) };

		await processDiscoveryMessage(jobV1, new FakeMessage(), {
			...deps,
			verify: verifiedFor(jobV1),
		});
		await processDiscoveryMessage(jobV2, new FakeMessage(), {
			...deps,
			verify: verifiedFor(jobV2),
		});

		const runKey1 = await runKeyFor(jobV1);
		const runKey2 = await runKeyFor(jobV2);
		expect(runKey1).not.toBe(runKey2);

		const a1 = await getAssessmentByRunKey(testEnv.DB, runKey1);
		const a2 = await getAssessmentByRunKey(testEnv.DB, runKey2);
		expect(a1?.cid).toBe(jobV1.cid);
		expect(a2?.cid).toBe(jobV2.cid);
	});
});

describe("processDiscoveryMessage: verification failures", () => {
	it("permanent verify failure (INVALID_PROOF) dead-letters and acks — nothing else happens", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			verify: () => Promise.reject(new PdsVerificationError("INVALID_PROOF", "bad proof")),
		});

		expect(msg.acked).toBe(1);
		expect(msg.retried).toBe(0);

		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ reason: string }>();
		expect(dl?.reason).toBe("INVALID_PROOF");

		const subject = await testEnv.DB.prepare(`SELECT 1 FROM subjects WHERE uri = ?`)
			.bind(uriFor(job))
			.first();
		expect(subject).toBeNull();

		const labels = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM issued_labels WHERE uri = ?`)
			.bind(uriFor(job))
			.first<{ n: number }>();
		expect(labels?.n).toBe(0);
	});

	it("CID mismatch dead-letters with RECORD_CID_MISMATCH, not INVALID_PROOF", async () => {
		// `deps.verify` fully replaces `fetchAndVerifyExactRecord` (the
		// exact-CID assertion lives inside that function, per
		// record-verification.test.ts) — so here the override simulates what
		// production would throw when the PDS serves a different CID than
		// the event named, rather than re-deriving the mismatch itself.
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			verify: () =>
				Promise.reject(
					new RecordVerificationError(
						"RECORD_CID_MISMATCH",
						`PDS served a different CID for ${uriFor(job)}`,
					),
				),
		});

		expect(msg.acked).toBe(1);
		expect(msg.retried).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ reason: string }>();
		expect(dl?.reason).toBe("RECORD_CID_MISMATCH");
	});

	it("transient DID resolution failure retries, no dead letter", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			verify: () =>
				Promise.reject(
					new RecordVerificationError(
						"DID_RESOLUTION_UNAVAILABLE",
						`could not resolve DID document for ${job.did}`,
					),
				),
		});

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ n: number }>();
		expect(dl?.n).toBe(0);
	});

	it("transient verify failure (PDS_NETWORK_ERROR) retries, no dead letter", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			verify: () =>
				Promise.reject(new PdsVerificationError("PDS_NETWORK_ERROR", "connection refused")),
		});

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ n: number }>();
		expect(dl?.n).toBe(0);
	});

	it("transient PDS 5xx retries, no dead letter", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			verify: () => Promise.reject(new PdsVerificationError("PDS_HTTP_ERROR", "server error", 503)),
		});

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
	});
});

describe("processDiscoveryMessage: delete", () => {
	it("tombstones the subject and cancels non-terminal runs", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		await processDiscoveryMessage(job, new FakeMessage(), { ...deps, verify: verifiedFor(job) });

		const runKey = await runKeyFor(job);
		const before = await getAssessmentByRunKey(testEnv.DB, runKey);
		expect(before?.state).toBe("pending");

		const deleteJob: DiscoveryJob = { ...job, operation: "delete", cid: "" };
		const msg = new FakeMessage();
		// The record is confirmed gone at the PDS.
		await processDiscoveryMessage(deleteJob, msg, {
			...deps,
			confirmDeleted: () => Promise.resolve(true),
		});

		expect(msg.acked).toBe(1);
		const subject = await testEnv.DB.prepare(
			`SELECT deleted_at FROM subjects WHERE uri = ? AND cid = ?`,
		)
			.bind(uriFor(job), job.cid)
			.first<{ deleted_at: string | null }>();
		expect(subject?.deleted_at).not.toBeNull();

		const after = await getAssessmentByRunKey(testEnv.DB, runKey);
		expect(after?.state).toBe("cancelled");

		// The pending label the run issued is negated, so a deleted release
		// stops advertising an in-progress assessment.
		const pending = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels
			 WHERE uri = ? AND val = 'assessment-pending' ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(uriFor(job))
			.first<{ neg: number }>();
		expect(pending?.neg).toBe(1);
	});

	it("dead-letters a forged/premature delete whose record still resolves, suppressing nothing", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		await processDiscoveryMessage(job, new FakeMessage(), { ...deps, verify: verifiedFor(job) });
		const runKey = await runKeyFor(job);

		const deleteJob: DiscoveryJob = { ...job, operation: "delete", cid: "" };
		const msg = new FakeMessage();
		// The record still resolves at the PDS — the delete is forged/premature.
		await processDiscoveryMessage(deleteJob, msg, {
			...deps,
			confirmDeleted: () => Promise.resolve(false),
		});

		expect(msg.acked).toBe(1);
		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ reason: string }>();
		expect(dl?.reason).toBe("DELETE_RECORD_PRESENT");
		// Subject not tombstoned, run not cancelled.
		const subject = await testEnv.DB.prepare(`SELECT deleted_at FROM subjects WHERE uri = ?`)
			.bind(uriFor(job))
			.first<{ deleted_at: string | null }>();
		expect(subject?.deleted_at).toBeNull();
		const after = await getAssessmentByRunKey(testEnv.DB, runKey);
		expect(after?.state).toBe("pending");
	});

	it("retries a delete whose absence check fails transiently", async () => {
		const job = await jobFor({ rkey: rkey(), operation: "delete", cid: "" });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			confirmDeleted: () =>
				Promise.reject(new PdsVerificationError("PDS_NETWORK_ERROR", "directory blip")),
		});

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
	});

	it("dead-letters a delete whose absence check fails permanently, not retry", async () => {
		const job = await jobFor({ rkey: rkey(), operation: "delete", cid: "" });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			confirmDeleted: () =>
				Promise.reject(new RecordVerificationError("DID_RESOLUTION_FAILED", "no PDS entry")),
		});

		expect(msg.acked).toBe(1);
		expect(msg.retried).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT reason FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ reason: string }>();
		expect(dl?.reason).toBe("DID_RESOLUTION_FAILED");
	});

	it("dead-letters nothing when a confirmed delete targets an unknown uri", async () => {
		const job = await jobFor({ rkey: rkey(), operation: "delete", cid: "" });
		const deps = await buildDeps();
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, {
			...deps,
			confirmDeleted: () => Promise.resolve(true),
		});

		expect(msg.acked).toBe(1);
		const dl = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ n: number }>();
		expect(dl?.n).toBe(0);
	});
});

describe("getCurrentAssessment", () => {
	it("stays unset for a pending-only run (no pointer move until finalization)", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		await processDiscoveryMessage(job, new FakeMessage(), { ...deps, verify: verifiedFor(job) });

		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: uriFor(job),
			cid: job.cid,
		});
		expect(pointer).toBeNull();
	});
});
