/**
 * The assessment Workflow is a thin durable shell over `AssessmentOrchestrator`.
 * Two layers are exercised here:
 *
 *  - `executeAssessmentInstance` (the shell body `run` wraps in a durable step):
 *    the idempotent terminal short-circuit, the not-found guard, and the
 *    fail-loud binding check.
 *  - `buildStages` assembled end-to-end through a real orchestrator with a fake
 *    aggregator, fake SSRF egress, fake AI, and a bundle fixture — the lifted
 *    deploy gate: a `passed` outcome now means a real acquire→scan ran, and a
 *    declared-vs-pinned drift blocks rather than fetching the wrong artifact.
 *
 * Cloudflare's Workflow runtime has no local harness, so the entrypoint class
 * is not constructed; both layers are driven directly.
 */

import { CODEC_RAW, create as createCid, toString as cidToString } from "@atcute/cid";
import {
	createLabelSigner,
	type LabelDidDocument,
	type LabelSigner,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { AcquisitionHolder } from "../src/artifact-acquisition.js";
import type { ArtifactEgress } from "../src/artifact-egress.js";
import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import { AssessmentOrchestrator } from "../src/assessment-orchestrator.js";
import { serializeCoverage, type CoverageAccumulator } from "../src/assessment-stages.js";
import {
	createAssessmentRun,
	createSubject,
	transitionAssessmentState,
} from "../src/assessment-store.js";
import { buildStages, executeAssessmentInstance } from "../src/assessment-workflow.js";
import type { AiBinding } from "../src/code-ai-adapter.js";
import type { PublisherVerificationReader } from "../src/history-context.js";
import type { ImageAiBinding } from "../src/image-ai-adapter.js";
import { MODERATION_POLICY } from "../src/policy.js";
import type { ReleaseReader } from "../src/release-resolution.js";
import { initializeSigningState } from "../src/signing-rotation.js";
import { canonicalBundle, checksumOf } from "./bundle-fixture.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const config = { labelerDid: LABELER_DID, signingKeyVersion: "v1" };

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

function signer(): Promise<LabelSigner> {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(),
	});
}

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
async function pendingRun(
	name: string,
	pins: { artifactChecksum?: string; artifactId?: string } = {},
): Promise<{ id: string; uri: string; cid: string }> {
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
		...(pins.artifactChecksum !== undefined ? { artifactChecksum: pins.artifactChecksum } : {}),
		...(pins.artifactId !== undefined ? { artifactId: pins.artifactId } : {}),
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

function servingEgress(bytes: Uint8Array): ArtifactEgress {
	return { fetch: async () => new Response(bytes), resolveHostname: async () => ["203.0.113.5"] };
}

function fakeAi(findings: unknown[]): AiBinding & ImageAiBinding {
	const run = () => Promise.resolve({ response: JSON.stringify({ findings }) });
	return { run } as unknown as AiBinding & ImageAiBinding;
}

function fakeAggregator(
	runCid: string,
	declaredChecksum: string,
): ReleaseReader & PublisherVerificationReader {
	const view = {
		cid: runCid,
		did: PUBLISHER_DID,
		indexedAt: "2026-07-17T00:00:00.000Z",
		package: "test-plugin",
		version: "1.0.0",
		uri: releaseUri("test-plugin"),
		release: {
			$type: "com.emdashcms.experimental.package.release",
			package: "test-plugin",
			version: "1.0.0",
			artifacts: {
				package: { url: "https://cdn.example.test/plugin.tgz", checksum: declaredChecksum },
			},
		},
	};
	return {
		getLatestRelease: async () => view as never,
		listReleases: async () => ({ releases: [view] }) as never,
		getPackage: async () => null,
		getPublisherVerification: async () => null,
	};
}

async function runFullPath(
	runId: string,
	runCid: string,
	options: {
		bundle: Uint8Array;
		declaredChecksum: string;
		ai?: AiBinding & ImageAiBinding;
	},
) {
	const holder: AcquisitionHolder = {};
	const coverage: CoverageAccumulator = {};
	const stages = buildStages({
		holder,
		coverage,
		config,
		policy: MODERATION_POLICY,
		db: testEnv.DB,
		egress: servingEgress(options.bundle),
		aggregator: fakeAggregator(runCid, options.declaredChecksum),
		ai: options.ai ?? fakeAi([]),
	});
	const orchestrator = new AssessmentOrchestrator({
		db: testEnv.DB,
		config,
		signer: await signer(),
		policy: MODERATION_POLICY,
		stages,
		sleep: () => Promise.resolve(),
		resolveCoverageJson: () => serializeCoverage(coverage),
	});
	return orchestrator.runAssessment(runId);
}

async function labelNeg(uri: string, cidValue: string, val: string): Promise<number | undefined> {
	const row = await testEnv.DB.prepare(
		`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = ? ORDER BY sequence DESC LIMIT 1`,
	)
		.bind(uri, cidValue, val)
		.first<{ neg: number }>();
	return row?.neg;
}

const minimalEnv = { DB: testEnv.DB } as unknown as Env;

describe("buildStages: assembled production path (deploy gate lifted)", () => {
	it("does not throw when assembling the four real stages", async () => {
		const bytes = await canonicalBundle();
		expect(() =>
			buildStages({
				holder: {},
				coverage: {},
				config,
				policy: MODERATION_POLICY,
				db: testEnv.DB,
				egress: servingEgress(bytes),
				aggregator: fakeAggregator("cid", "checksum"),
				ai: fakeAi([]),
			}),
		).not.toThrow();
	});

	it("acquires, scans clean, and finalizes passed with real coverage", async () => {
		const run = await pendingRun("wf-full-pass");
		const bytes = await canonicalBundle();
		const result = await runFullPath(run.id, run.cid, {
			bundle: bytes,
			declaredChecksum: await checksumOf(bytes),
		});

		expect(result.state).toBe("passed");
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBe(0);
		expect(JSON.parse(result.coverageJson)).toMatchObject({
			code: "complete",
			images: "not-present",
		});
	});

	it("blocks on a code-model block finding across the assembled stages", async () => {
		const run = await pendingRun("wf-full-block");
		const bytes = await canonicalBundle();
		const result = await runFullPath(run.id, run.cid, {
			bundle: bytes,
			declaredChecksum: await checksumOf(bytes),
			ai: fakeAi([
				{
					category: "malware",
					severity: "critical",
					title: "malware",
					publicSummary: "ships a payload",
					privateDetail: "backend.js drops a dropper",
					affectedFiles: ["backend.js"],
				},
			]),
		});

		expect(result.state).toBe("blocked");
		expect(await labelNeg(run.uri, run.cid, "malware")).toBe(0);
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBeUndefined();
	});

	it("blocks on declared-vs-pinned checksum drift without fetching the wrong artifact", async () => {
		const bytes = await canonicalBundle();
		const declared = await checksumOf(bytes);
		const run = await pendingRun("wf-drift", { artifactChecksum: `${declared}-tampered` });

		let fetched = false;
		const egress: ArtifactEgress = {
			fetch: async () => {
				fetched = true;
				return new Response(bytes);
			},
			resolveHostname: async () => ["203.0.113.5"],
		};
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const stages = buildStages({
			holder,
			coverage,
			config,
			policy: MODERATION_POLICY,
			db: testEnv.DB,
			egress,
			aggregator: fakeAggregator(run.cid, declared),
			ai: fakeAi([]),
		});
		const orchestrator = new AssessmentOrchestrator({
			db: testEnv.DB,
			config,
			signer: await signer(),
			policy: MODERATION_POLICY,
			stages,
			sleep: () => Promise.resolve(),
			resolveCoverageJson: () => serializeCoverage(coverage),
		});
		const result = await orchestrator.runAssessment(run.id);

		expect(result.state).toBe("blocked");
		expect(fetched).toBe(false);
		expect(holder.result).toBeUndefined();
		expect(await labelNeg(run.uri, run.cid, "artifact-integrity-failure")).toBe(0);
	});
});

describe("executeAssessmentInstance: shell", () => {
	it("throws when the assessment does not exist", async () => {
		await expect(
			executeAssessmentInstance(minimalEnv, "asmt_00000000000000000000000000"),
		).rejects.toThrow(/not found/);
	});

	it("short-circuits idempotently on an already-finalized terminal row", async () => {
		const run = await pendingRun("wf-idempotent");
		const bytes = await canonicalBundle();
		const first = await runFullPath(run.id, run.cid, {
			bundle: bytes,
			declaredChecksum: await checksumOf(bytes),
		});
		expect(first.state).toBe("passed");

		// A durable-step retry re-enters with the row now terminal: it must return
		// the finalized state without rebuilding stages (minimalEnv has no bindings).
		expect(await executeAssessmentInstance(minimalEnv, run.id)).toBe("passed");
	});

	it("fails loudly when a required binding is missing", async () => {
		const run = await pendingRun("wf-missing-binding");
		await expect(executeAssessmentInstance(minimalEnv, run.id)).rejects.toThrow(
			/missing required bindings/,
		);
	});
});
