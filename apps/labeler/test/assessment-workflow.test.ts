/**
 * The assessment Workflow is a thin durable shell over `AssessmentOrchestrator`
 * (whose stage execution and finalization `assessment-orchestrator.test.ts`
 * already covers). Cloudflare's Workflow runtime has no local test harness and
 * the entrypoint class cannot be constructed in the workers pool, so these
 * tests exercise `executeAssessmentInstance` — the shell body `run` wraps in a
 * durable step — directly: it must load the pending run, compose the
 * orchestrator, and finalize, plus resume idempotently on a re-run.
 */

import { CODEC_RAW, create as createCid, toString as cidToString } from "@atcute/cid";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import {
	createAssessmentRun,
	createSubject,
	getAssessment,
	transitionAssessmentState,
} from "../src/assessment-store.js";
import { executeAssessmentInstance } from "../src/assessment-workflow.js";
import { MODERATION_POLICY } from "../src/policy.js";
import { initializeSigningState } from "../src/signing-rotation.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	await initializeSigningState(testEnv.DB, {
		issuerDid: LABELER_DID,
		keyVersion: "v1",
		publicKeyMultibase: MULTIKEY,
	});
});

async function cid(seed: string): Promise<string> {
	const bytes = new TextEncoder().encode(seed);
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const value = await createCid(CODEC_RAW, new Uint8Array(buffer));
	return cidToString(value);
}

function releaseUri(name: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${name}:1.0.0`;
}

/** Creates a verified subject and a `pending` assessment run. */
async function pendingRun(name: string): Promise<{ id: string; uri: string; cid: string }> {
	const uri = releaseUri(name);
	const cidValue = await cid(name);
	await createSubject(testEnv.DB, {
		uri,
		cid: cidValue,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: `${name}:1.0.0`,
	});
	const triggerId = initialTriggerId(cidValue);
	const runKey = await computeRunKey({
		uri,
		cid: cidValue,
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: "unassigned",
		promptHash: "unassigned",
		scannerSetVersion: "unassigned",
		triggerId,
	});
	const { assessment } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri,
		cid: cidValue,
		trigger: "initial",
		triggerId,
		policyVersion: MODERATION_POLICY.policyVersion,
		coverageJson: "{}",
	});
	await transitionAssessmentState(testEnv.DB, {
		id: assessment.id,
		from: "observed",
		to: "verifying",
	});
	await transitionAssessmentState(testEnv.DB, {
		id: assessment.id,
		from: "verifying",
		to: "pending",
	});
	return { id: assessment.id, uri, cid: cidValue };
}

const workflowEnv = env as unknown as Env;

describe("executeAssessmentInstance", () => {
	it("drives a pending run through the orchestrator to finalization (passed, stub stages)", async () => {
		const run = await pendingRun("wf-happy");

		const state = await executeAssessmentInstance(workflowEnv, run.id);

		expect(state).toBe("passed");
		const finalized = await getAssessment(testEnv.DB, run.id);
		expect(finalized?.state).toBe("passed");

		// The run's own assessment-pending is negated on finalization.
		const pending = await testEnv.DB.prepare(
			`SELECT l.neg FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
			 WHERE l.uri = ? AND l.cid = ? AND l.val = 'assessment-pending'`,
		)
			.bind(run.uri, run.cid)
			.first<{ neg: number }>();
		expect(pending?.neg).toBe(1);
	});

	it("resumes idempotently: a re-run of an already-finalized assessment returns its state without re-entering the orchestrator", async () => {
		const run = await pendingRun("wf-resume");

		expect(await executeAssessmentInstance(workflowEnv, run.id)).toBe("passed");
		// A second execution (as a durable retry would do) must not throw on the
		// now-terminal row — the orchestrator's pending-guard would otherwise
		// reject it.
		expect(await executeAssessmentInstance(workflowEnv, run.id)).toBe("passed");
	});

	it("throws when the assessment does not exist", async () => {
		await expect(
			executeAssessmentInstance(workflowEnv, "asmt_00000000000000000000000000"),
		).rejects.toThrow(/not found/);
	});
});
