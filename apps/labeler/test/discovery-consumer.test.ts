import { CODEC_RAW, create as createCid, toString as cidToString } from "@atcute/cid";
import {
	createLabelSigner,
	verifyLabel,
	type LabelDidDocument,
	type LabelSigner,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
	type AssessmentWorkflowBinding,
	type AssessmentWorkflowParams,
} from "../src/assessment-dispatch.js";
import {
	automatedIdempotencyKey,
	computeRunKey,
	initialTriggerId,
} from "../src/assessment-lifecycle.js";
import { getAssessmentByRunKey, getCurrentAssessment } from "../src/assessment-store.js";
import { buildAutomationPauseUpdate } from "../src/automation-state.js";
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

interface FakeInstance {
	id: string;
	params: AssessmentWorkflowParams;
}

/** In-memory stand-in for the assessment Workflow binding that enforces
 * instance-id uniqueness the way the real one does: `create` throws when the id
 * is already taken (the per-subject lock), `get` resolves it. `createError`
 * simulates an infrastructure failure. */
class FakeAssessmentWorkflow implements AssessmentWorkflowBinding {
	readonly instances = new Map<string, FakeInstance>();
	readonly created: FakeInstance[] = [];
	createError: Error | undefined;

	create(options: { id: string; params: AssessmentWorkflowParams }): Promise<{ id: string }> {
		if (this.createError) return Promise.reject(this.createError);
		if (this.instances.has(options.id))
			return Promise.reject(new Error(`instance ${options.id} already exists`));
		const instance = { id: options.id, params: options.params };
		this.instances.set(options.id, instance);
		this.created.push(instance);
		return Promise.resolve({ id: options.id });
	}

	get(id: string): Promise<{ id: string }> {
		const instance = this.instances.get(id);
		if (!instance) return Promise.reject(new Error(`instance ${id} not found`));
		return Promise.resolve({ id });
	}
}

async function buildDeps(): Promise<DiscoveryConsumerDeps> {
	return {
		db: testEnv.DB,
		config,
		signer: await signer(),
		didDocumentResolver: new StubResolver(),
		assessmentWorkflow: new FakeAssessmentWorkflow(),
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

describe("processDiscoveryMessage: Workflow dispatch and per-subject lock", () => {
	it("dispatches one Workflow instance per verified subject, id derived from (uri, cid)", async () => {
		const job = await jobFor({ rkey: rkey() });
		const workflow = new FakeAssessmentWorkflow();
		const deps = { ...(await buildDeps()), assessmentWorkflow: workflow };
		const msg = new FakeMessage();

		await processDiscoveryMessage(job, msg, { ...deps, verify: verifiedFor(job) });

		expect(msg.acked).toBe(1);
		const runKey = await runKeyFor(job);
		const assessment = await getAssessmentByRunKey(testEnv.DB, runKey);
		expect(workflow.created).toHaveLength(1);
		expect(workflow.created[0]?.id).toBe(runKey);
		expect(workflow.created[0]?.params.assessmentId).toBe(assessment!.id);
	});

	it("redelivery does not start a second run — the instance id is the per-subject lock", async () => {
		const job = await jobFor({ rkey: rkey() });
		const workflow = new FakeAssessmentWorkflow();
		const deps = { ...(await buildDeps()), assessmentWorkflow: workflow };

		const first = new FakeMessage();
		const second = new FakeMessage();
		await processDiscoveryMessage(job, first, { ...deps, verify: verifiedFor(job) });
		await processDiscoveryMessage(job, second, { ...deps, verify: verifiedFor(job) });

		// Second create collides on the deterministic id; dispatch converges
		// rather than starting a duplicate run, and the message still acks.
		expect(workflow.created).toHaveLength(1);
		expect(first.acked).toBe(1);
		expect(second.acked).toBe(1);
		expect(second.retried).toBe(0);
	});

	it("distinct subjects (a new CID) get distinct Workflow instances", async () => {
		const name = rkey();
		const workflow = new FakeAssessmentWorkflow();
		const deps = { ...(await buildDeps()), assessmentWorkflow: workflow };
		const jobV1 = await jobFor({ rkey: name, cid: await cid(`${name}-wf-v1`) });
		const jobV2 = { ...jobV1, operation: "update" as const, cid: await cid(`${name}-wf-v2`) };

		await processDiscoveryMessage(jobV1, new FakeMessage(), {
			...deps,
			verify: verifiedFor(jobV1),
		});
		await processDiscoveryMessage(jobV2, new FakeMessage(), {
			...deps,
			verify: verifiedFor(jobV2),
		});

		expect(workflow.created).toHaveLength(2);
		expect(workflow.created[0]?.id).not.toBe(workflow.created[1]?.id);
	});

	it("retries (no dead letter) when dispatch fails, then re-dispatches on redelivery", async () => {
		const job = await jobFor({ rkey: rkey() });
		const workflow = new FakeAssessmentWorkflow();
		workflow.createError = new Error("workflows backend unavailable");
		const deps = { ...(await buildDeps()), assessmentWorkflow: workflow };

		const first = new FakeMessage();
		await processDiscoveryMessage(job, first, { ...deps, verify: verifiedFor(job) });

		// Dispatch failed with no surviving instance → retry, not dead-letter.
		expect(first.retried).toBe(1);
		expect(first.acked).toBe(0);
		expect(workflow.created).toHaveLength(0);
		const dl = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ n: number }>();
		expect(dl?.n).toBe(0);
		// The run still reached pending before the dispatch failure.
		const pending = await getAssessmentByRunKey(testEnv.DB, await runKeyFor(job));
		expect(pending?.state).toBe("pending");

		// Redelivery with the backend recovered converges: same run, one instance.
		workflow.createError = undefined;
		const second = new FakeMessage();
		await processDiscoveryMessage(job, second, { ...deps, verify: verifiedFor(job) });
		expect(second.acked).toBe(1);
		expect(workflow.created).toHaveLength(1);
		expect(workflow.created[0]?.id).toBe(await runKeyFor(job));
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

	it("retries (does not dead-letter) when issuance is paused mid-rotation", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();
		await testEnv.DB.prepare(
			`UPDATE signing_state SET phase = 'paused', pending_key_version = 'v2',
			 pending_public_multikey = ?, rotation_id = 'rot-1' WHERE id = 1`,
		)
			.bind(MULTIKEY)
			.run();
		try {
			await processDiscoveryMessage(job, msg, { ...deps, verify: verifiedFor(job) });
		} finally {
			await testEnv.DB.prepare(
				`UPDATE signing_state SET phase = 'active', pending_key_version = NULL,
				 pending_public_multikey = NULL, rotation_id = NULL WHERE id = 1`,
			).run();
		}

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ n: number }>();
		expect(dl?.n).toBe(0);
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

	it("retries a confirmed delete when pending-negation issuance is paused mid-rotation", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		await processDiscoveryMessage(job, new FakeMessage(), { ...deps, verify: verifiedFor(job) });

		const deleteJob: DiscoveryJob = { ...job, operation: "delete", cid: "" };
		const msg = new FakeMessage();
		await testEnv.DB.prepare(
			`UPDATE signing_state SET phase = 'paused', pending_key_version = 'v2',
			 pending_public_multikey = ?, rotation_id = 'rot-1' WHERE id = 1`,
		)
			.bind(MULTIKEY)
			.run();
		try {
			await processDiscoveryMessage(deleteJob, msg, {
				...deps,
				confirmDeleted: () => Promise.resolve(true),
			});
		} finally {
			await testEnv.DB.prepare(
				`UPDATE signing_state SET phase = 'active', pending_key_version = NULL,
				 pending_public_multikey = NULL, rotation_id = NULL WHERE id = 1`,
			).run();
		}

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
		const dl = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE rkey = ?`)
			.bind(job.rkey)
			.first<{ n: number }>();
		expect(dl?.n).toBe(0);
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

describe("processDiscoveryMessage: automation kill-switch", () => {
	const NOW = new Date("2026-07-13T00:00:00.000Z");
	const ACTION_ID = "oact_pausetest";

	beforeAll(async () => {
		await testEnv.DB.prepare(
			`INSERT INTO operator_actions
			 (id, actor_type, actor_id, role, action, reason, idempotency_key,
			  request_fingerprint, created_at, created_at_epoch_ms)
			 VALUES (?, 'human', 'u', 'admin', 'pause-issuance', 'r', ?, 'fp',
			         '2026-07-13T00:00:00.000Z', 0)`,
		)
			.bind(ACTION_ID, `key-${ACTION_ID}`)
			.run();
	});

	async function setPaused(paused: boolean): Promise<void> {
		await buildAutomationPauseUpdate(testEnv.DB, {
			paused,
			reason: paused ? "incident" : null,
			actionId: ACTION_ID,
			now: NOW,
		}).run();
	}

	afterEach(async () => {
		await setPaused(false);
	});

	it("retries and creates no run while ingestion is paused", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();
		await setPaused(true);

		await processDiscoveryMessage(job, msg, { ...deps, verify: verifiedFor(job) });

		expect(msg.retried).toBe(1);
		expect(msg.acked).toBe(0);
		const subject = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM subjects WHERE uri = ?`)
			.bind(uriFor(job))
			.first<{ n: number }>();
		expect(subject?.n).toBe(0);
	});

	it("processes normally once resumed", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();

		await setPaused(true);
		const first = new FakeMessage();
		await processDiscoveryMessage(job, first, { ...deps, verify: verifiedFor(job) });
		expect(first.retried).toBe(1);

		await setPaused(false);
		const second = new FakeMessage();
		await processDiscoveryMessage(job, second, { ...deps, verify: verifiedFor(job) });

		expect(second.acked).toBe(1);
		expect(second.retried).toBe(0);
		const assessment = await getAssessmentByRunKey(testEnv.DB, await runKeyFor(job));
		expect(assessment?.state).toBe("pending");
	});

	it("retries when the switch is unreadable (fails closed)", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		const msg = new FakeMessage();
		await testEnv.DB.prepare(`DELETE FROM automation_state WHERE id = 1`).run();

		try {
			await processDiscoveryMessage(job, msg, { ...deps, verify: verifiedFor(job) });
			expect(msg.retried).toBe(1);
			expect(msg.acked).toBe(0);
			const subject = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM subjects WHERE uri = ?`)
				.bind(uriFor(job))
				.first<{ n: number }>();
			expect(subject?.n).toBe(0);
		} finally {
			await testEnv.DB.prepare(
				`INSERT INTO automation_state (id, paused, updated_at, updated_at_epoch_ms)
				 VALUES (1, 0, '1970-01-01T00:00:00.000Z', 0)`,
			).run();
		}
	});

	it("does not gate the delete branch while ingestion is paused", async () => {
		const job = await jobFor({ rkey: rkey() });
		const deps = await buildDeps();
		await processDiscoveryMessage(job, new FakeMessage(), { ...deps, verify: verifiedFor(job) });

		await setPaused(true);
		const deleteJob: DiscoveryJob = { ...job, operation: "delete", cid: "" };
		const msg = new FakeMessage();
		await processDiscoveryMessage(deleteJob, msg, {
			...deps,
			confirmDeleted: () => Promise.resolve(true),
		});

		expect(msg.acked).toBe(1);
		expect(msg.retried).toBe(0);
		const after = await getAssessmentByRunKey(testEnv.DB, await runKeyFor(job));
		expect(after?.state).toBe("cancelled");
		const negated = await testEnv.DB.prepare(
			`SELECT neg FROM issued_labels
			 WHERE uri = ? AND val = 'assessment-pending' ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(uriFor(job))
			.first<{ neg: number }>();
		expect(negated?.neg).toBe(1);
	});
});
