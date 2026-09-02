import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	runAssessmentFoundation,
	type DurableAssessmentStep,
} from "../src/assessment/foundation.js";
import { createD1AssessmentLifecycleStore } from "../src/assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
import {
	AssessmentWorkflowConfigurationError,
	runBoundAssessmentWorkflow,
} from "../src/assessment/workflow.js";
import {
	ASSESSMENT_VERSIONS,
	PNG_BYTES,
	PROFILE_CID,
	PROFILE_RECORD,
	PROFILE_URI,
	RELEASE_CID,
	RELEASE_URI,
	createReleaseRecord,
} from "./assessment-fixtures.js";
import { createTestIssuer } from "./issuer-helpers.js";

class CachedStep implements DurableAssessmentStep {
	readonly calls: string[] = [];
	readonly #results = new Map<string, unknown>();

	async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
		if (this.#results.has(name)) return this.#results.get(name) as T;
		this.calls.push(name);
		const result = await callback();
		this.#results.set(name, result);
		return result;
	}

	result(name: string): unknown {
		return this.#results.get(name);
	}
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("assessment Workflow foundation", () => {
	it("does not repeat completed durable steps after a restart", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "workflow:restart-test",
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-24T10:00:00.000Z" });
		const verifyExactRecord = vi.fn(async () => ({
			uri: PROFILE_URI,
			cid: PROFILE_CID,
			record: {
				...PROFILE_RECORD,
				extensions: {
					manifest: { backend: "backend.js" },
					provenance: { url: "https://trap.invalid/provenance" },
				},
			},
			verification: "did-mst-signature" as const,
		}));
		const step = new CachedStep();
		const dependencies = {
			lifecycle,
			recordVerifier: { verifyExactRecord },
			now: () => new Date("2026-08-24T10:00:01.000Z"),
		};
		const first = await runAssessmentFoundation(params, step, dependencies);
		const callsAfterFirstRun = [...step.calls];
		const restarted = await runAssessmentFoundation(params, step, dependencies);
		expect(first).toMatchObject({ status: "prepared", mediaCount: 0 });
		if (first.status !== "prepared") throw new Error("assessment was unexpectedly cancelled");
		expect(restarted).toEqual(first);
		expect(step.calls).toEqual(callsAfterFirstRun);
		expect(verifyExactRecord).toHaveBeenCalledOnce();
		expect(step.calls).toEqual([
			"load authoritative assessment run",
			"start assessment run",
			"verify and project exact publisher record",
			"check displayed links",
			"fingerprint moderation input",
			"persist prepared assessment",
		]);
		const verifiedProjection = String(step.result("verify and project exact publisher record"));
		expect(verifiedProjection).not.toContain("backend.js");
		expect(verifiedProjection).not.toContain("manifest");
		const stored = await env.DB.prepare(
			`SELECT state, state_version, moderation_fingerprint, canonical_input_json, coverage_json
			 FROM assessments WHERE run_key = ?`,
		)
			.bind(params.runKey)
			.first<{
				state: string;
				state_version: number;
				moderation_fingerprint: string;
				canonical_input_json: string;
				coverage_json: string;
			}>();
		expect(stored).toMatchObject({
			state: "running",
			state_version: 2,
			moderation_fingerprint: first.moderationFingerprint,
		});
		expect(stored?.canonical_input_json).toContain("Gallery");
		expect(stored?.coverage_json).toContain('"acquisition":"collected"');
		expect(stored?.coverage_json).toContain('"inference":"pending"');
		expect(stored?.coverage_json).not.toContain("complete");
	});

	it("fails closed when the bound Workflow has no explicit production dependencies", async () => {
		await expect(
			runBoundAssessmentWorkflow(
				{
					instanceId: "unconfigured",
					workflowName: "assessment",
					payload: {
						runKey: "unconfigured",
						subjectUri: PROFILE_URI,
						subjectCid: PROFILE_CID,
						subjectKind: "profile",
					},
					timestamp: new Date("2026-08-24T10:00:00.000Z"),
				},
				new CachedStep(),
			),
		).rejects.toBeInstanceOf(AssessmentWorkflowConfigurationError);
	});

	it("runs durable inference, policy, and atomic label finalization after preparation", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "workflow:complete-pipeline",
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-24T10:30:00.000Z" });
		const moderate = vi.fn(
			async (request: { text: readonly { ref: string }[]; links: readonly { ref: string }[] }) => ({
				findings: [],
				coveredEvidenceRefs: [
					...request.text.map(({ ref }) => ref),
					...request.links.map(({ ref }) => ref),
				],
				identity: {
					adapterVersion: "listing-metadata-ai-v1",
					modelId: ASSESSMENT_VERSIONS.textModelId,
					promptVersion: "listing-text-v1",
					promptHash: ASSESSMENT_VERSIONS.textPromptHash,
					parameters: {},
				},
				latencyMs: 1,
				usage: { configuredUnits: 1 },
			}),
		);
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const step = new CachedStep();
		const result = await runBoundAssessmentWorkflow(
			{
				instanceId: params.runKey,
				workflowName: "assessment",
				payload: params,
				timestamp: new Date("2026-08-24T10:30:00.000Z"),
			},
			step,
			{
				lifecycle,
				recordVerifier: {
					async verifyExactRecord() {
						return {
							uri: PROFILE_URI,
							cid: PROFILE_CID,
							record: PROFILE_RECORD,
							verification: "did-mst-signature" as const,
						};
					},
				},
				textAdapter: {
					identity: {
						adapterVersion: "listing-metadata-ai-v1",
						modelId: ASSESSMENT_VERSIONS.textModelId,
						promptVersion: "listing-text-v1",
						promptHash: ASSESSMENT_VERSIONS.textPromptHash,
						parameters: {},
					},
					moderate,
				},
				policy: {
					...INITIAL_LISTING_POLICY_FIXTURE,
					policyVersion: ASSESSMENT_VERSIONS.policyVersion,
				},
				finalizer: issuer,
				now: () => new Date("2026-08-24T10:30:01.000Z"),
			},
		);

		expect(result).toMatchObject({ status: "review", runKey: params.runKey });
		expect(moderate).toHaveBeenCalledOnce();
		expect(step.calls.slice(-3)).toEqual([
			"moderate displayed text and links",
			"resolve assessment policy",
			"finalize assessment and signed label",
		]);
		expect(await lifecycle.getRun(params.runKey)).toMatchObject({ state: "review" });
		const issued = await env.DB.prepare(
			"SELECT val, cid FROM issued_labels WHERE assessment_id = ?",
		)
			.bind(params.runKey)
			.first<{ val: string; cid: string }>();
		expect(issued).toEqual({ val: "listing-review", cid: PROFILE_CID });
	});

	it("finalizes as an error when required display media cannot be acquired", async () => {
		const checksum = await computeMultihash(PNG_BYTES);
		if (!checksum.success) throw new Error("test checksum could not be computed");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "workflow:media-acquisition-error",
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-24T10:45:00.000Z" });
		const identity = {
			adapterVersion: "listing-metadata-ai-v1",
			modelId: ASSESSMENT_VERSIONS.textModelId,
			promptVersion: "listing-text-v1",
			promptHash: ASSESSMENT_VERSIONS.textPromptHash,
			parameters: {},
		};
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const result = await runBoundAssessmentWorkflow(
			{
				instanceId: params.runKey,
				workflowName: "assessment",
				payload: params,
				timestamp: new Date("2026-08-24T10:45:00.000Z"),
			},
			new CachedStep(),
			{
				lifecycle,
				recordVerifier: {
					async verifyExactRecord() {
						return {
							uri: RELEASE_URI,
							cid: RELEASE_CID,
							record: createReleaseRecord(checksum.value),
							verification: "did-mst-signature" as const,
						};
					},
				},
				mediaAcquirer: {
					async acquire() {
						throw new Error("fixture media service unavailable");
					},
				},
				textAdapter: {
					identity,
					async moderate(request) {
						return {
							findings: [],
							coveredEvidenceRefs: [
								...request.text.map(({ ref }) => ref),
								...request.links.map(({ ref }) => ref),
							],
							identity,
							latencyMs: 1,
							usage: { configuredUnits: 1 },
						};
					},
				},
				policy: {
					...INITIAL_LISTING_POLICY_FIXTURE,
					policyVersion: ASSESSMENT_VERSIONS.policyVersion,
				},
				finalizer: issuer,
				now: () => new Date("2026-08-24T10:45:01.000Z"),
			},
		);

		expect(result).toMatchObject({ status: "error", mediaCount: 0 });
		expect(await lifecycle.getRun(params.runKey)).toMatchObject({ state: "error" });
		expect(
			await env.DB.prepare("SELECT val FROM issued_labels WHERE assessment_id = ?")
				.bind(params.runKey)
				.first<string>("val"),
		).toBe("listing-error");
	});

	it("bounds concurrent image inference for a release with many display images", async () => {
		const checksum = await computeMultihash(PNG_BYTES);
		if (!checksum.success) throw new Error("test checksum could not be computed");
		const sha256 = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", PNG_BYTES)),
			(value) => value.toString(16).padStart(2, "0"),
		).join("");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "workflow:image-inference-concurrency",
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-24T10:47:00.000Z" });
		const baseRecord = createReleaseRecord(checksum.value);
		const record = {
			...baseRecord,
			artifacts: {
				...baseRecord.artifacts,
				screenshots: Array.from({ length: 5 }, (_, index) => ({
					url: `https://media.example/screenshot-${index}.png`,
					checksum: checksum.value,
					contentType: "image/png" as const,
					width: 1,
					height: 1,
				})),
			},
		};
		const identity = {
			adapterVersion: "listing-metadata-ai-v1",
			modelId: ASSESSMENT_VERSIONS.textModelId,
			promptVersion: "listing-text-v1",
			promptHash: ASSESSMENT_VERSIONS.textPromptHash,
			parameters: {},
		};
		const imageIdentity = {
			...identity,
			modelId: ASSESSMENT_VERSIONS.imageModelId,
			promptVersion: "listing-image-v1",
			promptHash: ASSESSMENT_VERSIONS.imagePromptHash,
		};
		let active = 0;
		let maximumActive = 0;
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		await runBoundAssessmentWorkflow(
			{
				instanceId: params.runKey,
				workflowName: "assessment",
				payload: params,
				timestamp: new Date("2026-08-24T10:47:00.000Z"),
			},
			new CachedStep(),
			{
				lifecycle,
				recordVerifier: {
					async verifyExactRecord() {
						return {
							uri: RELEASE_URI,
							cid: RELEASE_CID,
							record,
							verification: "did-mst-signature" as const,
						};
					},
				},
				mediaAcquirer: {
					async acquire(_subject, descriptor) {
						return {
							kind: descriptor.kind,
							index: descriptor.index,
							sha256,
							mimeType: "image/png" as const,
							byteLength: PNG_BYTES.byteLength,
							width: 1,
							height: 1,
							frames: 1,
							contentAddress: `sha256:${sha256}`,
							contentRef: `fixture://${descriptor.kind}/${descriptor.index}`,
						};
					},
				},
				mediaReader: {
					async read() {
						return PNG_BYTES;
					},
				},
				textAdapter: {
					identity,
					async moderate(request) {
						return {
							findings: [],
							coveredEvidenceRefs: [
								...request.text.map(({ ref }) => ref),
								...request.links.map(({ ref }) => ref),
							],
							identity,
							latencyMs: 1,
							usage: { configuredUnits: 1 },
						};
					},
				},
				imageAdapter: {
					identity: imageIdentity,
					async moderate(request) {
						active += 1;
						maximumActive = Math.max(maximumActive, active);
						await scheduler.wait(10);
						active -= 1;
						return {
							findings: [],
							coveredEvidenceRefs: [request.evidenceRef],
							identity: imageIdentity,
							latencyMs: 10,
							usage: { configuredUnits: 1 },
						};
					},
				},
				policy: {
					...INITIAL_LISTING_POLICY_FIXTURE,
					policyVersion: ASSESSMENT_VERSIONS.policyVersion,
				},
				finalizer: issuer,
				now: () => new Date("2026-08-24T10:47:01.000Z"),
			},
		);

		expect(maximumActive).toBeLessThanOrEqual(3);
	});

	it("stores an operational error without issuing a label when exact verification fails", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "workflow:record-verification-error",
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-24T10:50:00.000Z" });
		const identity = {
			adapterVersion: "listing-metadata-ai-v1",
			modelId: ASSESSMENT_VERSIONS.textModelId,
			promptVersion: "listing-text-v1",
			promptHash: ASSESSMENT_VERSIONS.textPromptHash,
			parameters: {},
		};
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const result = await runBoundAssessmentWorkflow(
			{
				instanceId: params.runKey,
				workflowName: "assessment",
				payload: params,
				timestamp: new Date("2026-08-24T10:50:00.000Z"),
			},
			new CachedStep(),
			{
				lifecycle,
				recordVerifier: {
					async verifyExactRecord() {
						throw new Error("publisher proof is invalid");
					},
				},
				textAdapter: {
					identity,
					async moderate() {
						throw new Error("must not run");
					},
				},
				policy: {
					...INITIAL_LISTING_POLICY_FIXTURE,
					policyVersion: ASSESSMENT_VERSIONS.policyVersion,
				},
				finalizer: issuer,
				now: () => new Date("2026-08-24T10:50:01.000Z"),
			},
		);
		expect(result).toEqual({ runKey: params.runKey, status: "error" });
		expect(await lifecycle.getRun(params.runKey)).toMatchObject({ state: "error" });
		expect(
			await env.DB.prepare("SELECT id FROM issued_labels WHERE assessment_id = ?")
				.bind(params.runKey)
				.first(),
		).toBeNull();
	});

	it("carries every never-fetch trap as inert metadata and acquires only display media", async () => {
		const checksum = await computeMultihash(PNG_BYTES);
		if (!checksum.success) throw new Error("test checksum could not be computed");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "workflow:release-traps",
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-24T11:00:00.000Z" });
		const acquired: string[] = [];
		const step = new CachedStep();
		await runAssessmentFoundation(params, step, {
			lifecycle,
			recordVerifier: {
				async verifyExactRecord() {
					return {
						uri: RELEASE_URI,
						cid: RELEASE_CID,
						record: createReleaseRecord(checksum.value),
						verification: "did-mst-signature" as const,
					};
				},
			},
			mediaAcquirer: {
				async acquire(_subject, descriptor) {
					acquired.push(descriptor.url);
					return {
						kind: descriptor.kind,
						index: descriptor.index,
						sha256: "11".repeat(32),
						mimeType: "image/png",
						byteLength: PNG_BYTES.byteLength,
						width: 1,
						height: 1,
						frames: 1,
						contentAddress: `sha256:${"11".repeat(32)}`,
						contentRef: "quarantine://release/icon",
					};
				},
			},
			now: () => new Date("2026-08-24T11:00:01.000Z"),
		});
		expect(acquired).toEqual(["https://media.example/icon.png"]);
		const projection = String(step.result("verify and project exact publisher record"));
		expect(projection).toContain("neverFetchUrls");
		expect(projection).toContain("package.tgz");
		expect(projection).not.toContain("declaredAccess");
	});
});
