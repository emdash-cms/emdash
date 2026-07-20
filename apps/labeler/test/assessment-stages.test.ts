import { CODEC_RAW, create as createCid, toString as cidToString } from "@atcute/cid";
import {
	createLabelSigner,
	type LabelDidDocument,
	type LabelSigner,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	createAcquireStage,
	type AcquisitionHolder,
	type AcquisitionTarget,
} from "../src/artifact-acquisition.js";
import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import {
	AssessmentOrchestrator,
	stubStages,
	type OrchestratorStages,
} from "../src/assessment-orchestrator.js";
import {
	createCodeAiStage,
	createHistoryStage,
	createImageAiStage,
	serializeCoverage,
	type CoverageAccumulator,
} from "../src/assessment-stages.js";
import {
	createAssessmentRun,
	createSubject,
	transitionAssessmentState,
} from "../src/assessment-store.js";
import type { AiBinding, AiRunInputs } from "../src/code-ai-adapter.js";
import type { PublisherVerificationReader } from "../src/history-context.js";
import type { ImageAiBinding } from "../src/image-ai-adapter.js";
import { MODERATION_POLICY } from "../src/policy.js";
import { initializeSigningState } from "../src/signing-rotation.js";
import { canonicalBundle, checksumOf, file } from "./bundle-fixture.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const PROMPT_VERSION = "prompt-test-v1";
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

async function signer(): Promise<LabelSigner> {
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
	return cidToString(await createCid(CODEC_RAW, new Uint8Array(buffer)));
}

function releaseUri(name: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${name}:1.0.0`;
}

async function pendingRun(name: string): Promise<{ id: string; uri: string; cid: string }> {
	const cidValue = await cid(name);
	const uri = releaseUri(name);
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

async function buildOrchestrator(
	stages: OrchestratorStages,
	overrides: { coverage?: CoverageAccumulator; maxStageRetries?: number } = {},
): Promise<AssessmentOrchestrator> {
	return new AssessmentOrchestrator({
		db: testEnv.DB,
		config,
		signer: await signer(),
		policy: MODERATION_POLICY,
		stages,
		sleep: () => Promise.resolve(),
		...(overrides.coverage !== undefined
			? { resolveCoverageJson: () => serializeCoverage(overrides.coverage!) }
			: {}),
		...(overrides.maxStageRetries !== undefined
			? { maxStageRetries: overrides.maxStageRetries }
			: {}),
	});
}

function fakeAi(run: (model: string, inputs: AiRunInputs) => Promise<unknown>): AiBinding {
	return { run };
}

function findingResponse(findings: unknown[]): { response: string } {
	return { response: JSON.stringify({ findings }) };
}

const nullAggregator: PublisherVerificationReader = { getPublisherVerification: async () => null };

const BLOCK_FINDING = {
	category: "malware",
	severity: "critical",
	title: "malware detected",
	publicSummary: "the plugin ships a malicious payload",
	privateDetail: "backend.js drops an obfuscated dropper",
	affectedFiles: ["backend.js"],
};

const WARN_FINDING = {
	category: "obfuscated-code",
	severity: "medium",
	title: "obfuscated payload",
	publicSummary: "the code appears obfuscated",
	privateDetail: "backend.js base64-decodes a runtime string",
	affectedFiles: ["backend.js"],
};

function targetFor(checksum: string): (assessment: { uri: string }) => Promise<AcquisitionTarget> {
	return async () => ({
		url: "https://cdn.example.test/plugin.tgz",
		checksum,
		slug: "test-plugin",
		version: "1.0.0",
	});
}

/** Test-injected acquire stage that serves `bytes` and pins `checksum`. When
 * `checksum` matches the bytes it publishes the bundle to `holder`; a mismatch
 * yields the permanent artifact-integrity-failure finding and leaves `holder`
 * empty — the two shapes the AI stages branch on. */
function acquireStage(bytes: Uint8Array, checksum: string, holder: AcquisitionHolder) {
	return createAcquireStage({
		deps: {
			fetch: async () => new Response(bytes),
			resolveHostname: async () => ["203.0.113.5"],
		},
		resolveTarget: targetFor(checksum),
		holder,
	});
}

async function labelNeg(uri: string, cidValue: string, val: string): Promise<number | undefined> {
	const row = await testEnv.DB.prepare(
		`SELECT neg FROM issued_labels WHERE uri = ? AND cid = ? AND val = ? ORDER BY sequence DESC LIMIT 1`,
	)
		.bind(uri, cidValue, val)
		.first<{ neg: number }>();
	return row?.neg;
}

describe("analysis stages: code AI stage", () => {
	it("blocks and issues the mapped label when the code model returns an automated-block finding", async () => {
		const run = await pendingRun("code-block");
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const ai = fakeAi(() => Promise.resolve(findingResponse([BLOCK_FINDING])));
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID, aggregator: nullAggregator }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("blocked");
		expect(await labelNeg(run.uri, run.cid, "malware")).toBe(0);
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBeUndefined();
	});

	it("passes on a clean model response and records complete code coverage", async () => {
		const run = await pendingRun("code-clean");
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const ai = fakeAi(() => Promise.resolve(findingResponse([])));
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("passed");
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBe(0);
		expect(JSON.parse(result.coverageJson)).toMatchObject({
			code: "complete",
			images: "unavailable",
			metadata: "unavailable",
			droppedFiles: [],
		});
	});

	it("warns and issues the warning label alongside assessment-passed", async () => {
		const run = await pendingRun("code-warn");
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const ai = fakeAi(() => Promise.resolve(findingResponse([WARN_FINDING])));
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("warned");
		expect(await labelNeg(run.uri, run.cid, "obfuscated-code")).toBe(0);
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBe(0);
	});

	it("finalizes error, never a spurious pass, when the model call keeps failing transiently", async () => {
		const run = await pendingRun("code-transient");
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		let calls = 0;
		const ai = fakeAi(() => {
			calls += 1;
			return Promise.reject(new Error("model overloaded"));
		});
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (
			await buildOrchestrator(stages, { coverage, maxStageRetries: 1 })
		).runAssessment(run.id);

		expect(result.state).toBe("error");
		expect(calls).toBe(2);
		expect(await labelNeg(run.uri, run.cid, "assessment-error")).toBe(0);
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBeUndefined();
	});

	it("records partial coverage and the dropped file when the model input budget drops a file", async () => {
		const run = await pendingRun("code-partial");
		// Two files, each under the per-file bundle cap (128 KiB) but together over
		// the model's 200k-char input budget, so the code adapter drops the larger.
		const bytes = await canonicalBundle([
			file("big-a.js", "a".repeat(125_000)),
			file("big-b.js", "b".repeat(120_000)),
		]);
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const ai = fakeAi(() => Promise.resolve(findingResponse([])));
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("passed");
		const parsed = JSON.parse(result.coverageJson);
		expect(parsed.code).toBe("partial");
		expect(parsed.droppedFiles).toContain("big-a.js");
	});
});

describe("analysis stages: acquire produced no bundle", () => {
	it("no-ops the code stage and finalizes on the deterministic acquire finding", async () => {
		const run = await pendingRun("acquire-permanent");
		const served = await canonicalBundle([file("tampered.js", "steal();")]);
		const pinned = await checksumOf(await canonicalBundle());
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		let modelCalled = false;
		const ai = fakeAi(() => {
			modelCalled = true;
			return Promise.resolve(findingResponse([]));
		});
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(served, pinned, holder),
			codeAi: createCodeAiStage({
				holder,
				ai,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("blocked");
		expect(modelCalled).toBe(false);
		expect(holder.result).toBeUndefined();
		expect(await labelNeg(run.uri, run.cid, "artifact-integrity-failure")).toBe(0);
		expect(JSON.parse(result.coverageJson).code).toBe("unavailable");
	});
});

function pngBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

function imageFakeAi(run: (model: string, inputs: unknown) => Promise<unknown>): ImageAiBinding {
	return { run: run as ImageAiBinding["run"] };
}

const IMAGE_WARN_FINDING = {
	category: "obfuscated-code",
	severity: "medium",
	title: "suspicious UI",
	publicSummary: "the icon mimics a system dialog",
	privateDetail: "icon.png renders a fake credential prompt",
	affectedImages: ["icon.png"],
};

/** Acquire stage variant that pins a description onto the resolved target, so
 * the AI stages receive a real stated-purpose input. */
function acquireStageWithDescription(
	bytes: Uint8Array,
	checksum: string,
	holder: AcquisitionHolder,
	description: string,
) {
	return createAcquireStage({
		deps: {
			fetch: async () => new Response(bytes),
			resolveHostname: async () => ["203.0.113.5"],
		},
		resolveTarget: async () => ({
			url: "https://cdn.example.test/plugin.tgz",
			checksum,
			slug: "test-plugin",
			version: "1.0.0",
			description,
		}),
		holder,
	});
}

describe("analysis stages: image AI stage", () => {
	it("runs the vision model over extracted images and flows findings into the outcome", async () => {
		const run = await pendingRun("image-warn");
		const bytes = await canonicalBundle([file("icon.png", pngBytes(128, 128))]);
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const codeAi = fakeAi(() => Promise.resolve(findingResponse([])));
		const imageAi = imageFakeAi(() =>
			Promise.resolve({ response: JSON.stringify({ findings: [IMAGE_WARN_FINDING] }) }),
		);
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai: codeAi,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			imageAi: createImageAiStage({
				holder,
				ai: imageAi,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("warned");
		expect(await labelNeg(run.uri, run.cid, "obfuscated-code")).toBe(0);
		expect(JSON.parse(result.coverageJson).images).toBe("complete");
	});

	it("records not-present and never calls the model when the bundle has no images", async () => {
		const run = await pendingRun("image-none");
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		let imageModelCalled = false;
		const imageAi = imageFakeAi(() => {
			imageModelCalled = true;
			return Promise.resolve({ response: JSON.stringify({ findings: [] }) });
		});
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai: fakeAi(() => Promise.resolve(findingResponse([]))),
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			imageAi: createImageAiStage({
				holder,
				ai: imageAi,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("passed");
		expect(imageModelCalled).toBe(false);
		expect(JSON.parse(result.coverageJson).images).toBe("not-present");
	});

	it("keeps a code-stage block when the image stage transient-exhausts (not discarded to error)", async () => {
		const run = await pendingRun("image-block-preserved");
		const bytes = await canonicalBundle([file("icon.png", pngBytes(128, 128))]);
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const codeAi = fakeAi(() => Promise.resolve(findingResponse([BLOCK_FINDING])));
		const imageAi = imageFakeAi(() => Promise.reject(new Error("vision model overloaded")));
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai: codeAi,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			imageAi: createImageAiStage({
				holder,
				ai: imageAi,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (
			await buildOrchestrator(stages, { coverage, maxStageRetries: 1 })
		).runAssessment(run.id);

		expect(result.state).toBe("blocked");
		expect(await labelNeg(run.uri, run.cid, "malware")).toBe(0);
		expect(await labelNeg(run.uri, run.cid, "assessment-error")).toBeUndefined();
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBeUndefined();
	});

	it("finalizes error on a transient image model failure and reports code complete, images unavailable", async () => {
		const run = await pendingRun("image-transient");
		const bytes = await canonicalBundle([file("icon.png", pngBytes(128, 128))]);
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const imageAi = imageFakeAi(() => Promise.reject(new Error("vision model overloaded")));
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai: fakeAi(() => Promise.resolve(findingResponse([]))),
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			imageAi: createImageAiStage({
				holder,
				ai: imageAi,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (
			await buildOrchestrator(stages, { coverage, maxStageRetries: 1 })
		).runAssessment(run.id);

		expect(result.state).toBe("error");
		const parsed = JSON.parse(result.coverageJson);
		expect(parsed.code).toBe("complete");
		expect(parsed.images).toBe("unavailable");
	});
});

describe("analysis stages: release description threading", () => {
	it("passes the resolved release description into the code model input", async () => {
		const run = await pendingRun("desc-thread");
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const description = "Imports your contacts and posts on your behalf.";
		let capturedInput = "";
		const codeAi = fakeAi((_model, inputs) => {
			capturedInput = JSON.stringify(inputs);
			return Promise.resolve(findingResponse([]));
		});
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStageWithDescription(bytes, await checksumOf(bytes), holder, description),
			codeAi: createCodeAiStage({
				holder,
				ai: codeAi,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: testEnv.DB, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("passed");
		expect(capturedInput).toContain(description);
	});
});

describe("analysis stages: history stage is best-effort", () => {
	it("does not fail the run when the history stage's own lookup throws internally", async () => {
		const run = await pendingRun("history-throws");
		const bytes = await canonicalBundle();
		const holder: AcquisitionHolder = {};
		const coverage: CoverageAccumulator = {};
		const ai = fakeAi(() => Promise.resolve(findingResponse([])));
		const brokenDb = {
			prepare() {
				throw new Error("history db unavailable");
			},
		} as unknown as D1Database;
		const stages: OrchestratorStages = {
			...stubStages,
			acquire: acquireStage(bytes, await checksumOf(bytes), holder),
			codeAi: createCodeAiStage({
				holder,
				ai,
				policy: MODERATION_POLICY,
				promptVersion: PROMPT_VERSION,
				coverage,
			}),
			history: createHistoryStage({ db: brokenDb, src: LABELER_DID }),
		};

		const result = await (await buildOrchestrator(stages, { coverage })).runAssessment(run.id);

		expect(result.state).toBe("passed");
		expect(await labelNeg(run.uri, run.cid, "assessment-passed")).toBe(0);
	});
});
