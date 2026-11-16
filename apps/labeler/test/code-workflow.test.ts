import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DurableAssessmentStep } from "../src/assessment/foundation.js";
import { createD1AssessmentLifecycleStore } from "../src/assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
import { runBoundAssessmentWorkflow } from "../src/assessment/workflow.js";
import type { CodeAssessmentDependencies } from "../src/code/assessment.js";
import {
	ASSESSMENT_VERSIONS,
	RELEASE_CID,
	RELEASE_URI,
	createReleaseRecord,
} from "./assessment-fixtures.js";
import {
	checksumOf,
	cleanBundleEntries,
	createBundle,
	loadExampleRuleset,
} from "./code-fixtures.js";
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
}

const TEXT_IDENTITY = {
	adapterVersion: "listing-metadata-ai-v1",
	modelId: ASSESSMENT_VERSIONS.textModelId,
	promptVersion: "listing-text-v1",
	promptHash: ASSESSMENT_VERSIONS.textPromptHash,
	parameters: {},
};

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function runRelease(options: {
	cid: string;
	bundle: Uint8Array;
	checksum?: string;
	declaredAccess?: Record<string, unknown>;
	readBundle?: () => Promise<Uint8Array>;
}) {
	const base = createReleaseRecord("bafyunused");
	const record = {
		$type: base.$type,
		package: base.package,
		version: base.version,
		artifacts: {
			package: {
				url: "https://trap.invalid/package.tgz",
				checksum: options.checksum ?? (await checksumOf(options.bundle)),
			},
		},
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				declaredAccess: options.declaredAccess ?? {
					network: { request: { allowedHosts: ["api.example.com"] } },
				},
			},
		},
	};
	const lifecycle = createD1AssessmentLifecycleStore(env.DB);
	const params = await createAssessmentWorkflowParams({
		subject: { uri: RELEASE_URI, cid: options.cid, kind: "release" },
		versions: ASSESSMENT_VERSIONS,
		logicalTriggerId: `workflow:code:${options.cid}`,
	});
	await lifecycle.observeRun({ params, observedAt: "2026-11-16T10:00:00.000Z" });
	const loaded = await loadExampleRuleset();
	const codeAssessment: CodeAssessmentDependencies = {
		rulesets: { load: async () => loaded },
		bundleReader: { read: options.readBundle ?? (async () => options.bundle) },
		previousReleases: { previousRelease: async () => null },
	};
	const step = new CachedStep();
	const result = await runBoundAssessmentWorkflow(
		{
			instanceId: params.runKey,
			workflowName: "assessment",
			payload: params,
			timestamp: new Date("2026-11-16T10:00:00.000Z"),
		},
		step,
		{
			lifecycle,
			recordVerifier: {
				async verifyExactRecord() {
					return {
						uri: RELEASE_URI,
						cid: options.cid,
						record,
						verification: "did-mst-signature" as const,
					};
				},
			},
			textAdapter: {
				identity: TEXT_IDENTITY,
				async moderate(request) {
					return {
						findings: [],
						coveredEvidenceRefs: [
							...request.text.map(({ ref }) => ref),
							...request.links.map(({ ref }) => ref),
						],
						identity: TEXT_IDENTITY,
						latencyMs: 1,
						usage: {},
					};
				},
			},
			codeAssessment,
			policy: {
				...INITIAL_LISTING_POLICY_FIXTURE,
				policyVersion: ASSESSMENT_VERSIONS.policyVersion,
				autoPass: "assisted",
			},
			finalizer: await createTestIssuer(env.DB, {
				automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
			}),
			now: () => new Date("2026-11-16T10:00:01.000Z"),
		},
	);
	const stored = await env.DB.prepare(
		"SELECT coverage_json, summary_json FROM assessments WHERE run_key = ?",
	)
		.bind(params.runKey)
		.first<{ coverage_json: string; summary_json: string }>();
	const label = await env.DB.prepare("SELECT val FROM issued_labels WHERE assessment_id = ?")
		.bind(params.runKey)
		.first<string>("val");
	const findings = await env.DB.prepare(
		`SELECT category, severity, public_summary, evidence_refs_json FROM findings
		 WHERE assessment_id = ? ORDER BY finding_index`,
	)
		.bind(params.runKey)
		.all<{
			category: string;
			severity: string;
			public_summary: string;
			evidence_refs_json: string;
		}>();
	return { result, step, stored, label, findings: findings.results, loaded };
}

describe("release code assessment in the assessment Workflow", () => {
	it("passes a clean package and records the ruleset that assessed it", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}clna`,
			bundle: await createBundle(cleanBundleEntries()),
		});
		expect(run.result.status).toBe("passed");
		expect(run.label).toBe("listing-passed");
		expect(run.step.calls).toEqual(
			expect.arrayContaining(["verify and project release package", "scan release package code"]),
		);
		expect(JSON.parse(run.stored!.coverage_json)).toMatchObject({ code: "complete" });
		expect(JSON.parse(run.stored!.summary_json).codeIdentity).toEqual({
			engineVersion: "code-assessment-engine-v1",
			rulesetId: "emdash-example",
			rulesetVersion: "2026-11-16.1",
			rulesetSha256: run.loaded.sha256,
		});
	});

	it("holds a package with code and access findings for review", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}reva`,
			bundle: await createBundle(
				cleanBundleEntries("export default { run: (code) => eval(code) };\n"),
			),
			declaredAccess: { network: { request: { allowedHosts: ["*"] } } },
		});
		expect(run.result.status).toBe("review");
		expect(run.label).toBe("listing-review");
		expect(run.findings.map(({ category, severity }) => [category, severity])).toEqual([
			["unsafe-code", "high"],
			["access-risk", "high"],
		]);
		expect(JSON.parse(run.findings[0]!.evidence_refs_json)).toEqual([
			"release.package:backend.js#L1C32:32-36",
		]);
		expect(run.findings[1]?.public_summary).toMatch(/^access-wildcard-host: /);
	});

	it("reports archive anomalies as findings instead of failing", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}anma`,
			bundle: await createBundle([
				...cleanBundleEntries(),
				{ name: "../../escape.js", content: "x" },
			]),
		});
		expect(run.result.status).toBe("review");
		expect(run.findings).toMatchObject([{ category: "package-integrity", severity: "critical" }]);
	});

	it.each([
		[
			"the bundle cannot be read",
			"erra",
			async () => ({ readBundle: async () => Promise.reject(new Error("cache down")) }),
		],
		[
			"the bundle does not match its signed checksum",
			"erba",
			async () => ({ checksum: await checksumOf(new TextEncoder().encode("other bytes")) }),
		],
	])("fails closed with an error label when %s", async (_name, suffix, overrides) => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}${suffix}`,
			bundle: await createBundle(cleanBundleEntries()),
			...(await overrides()),
		});
		expect(run.result.status).toBe("error");
		expect(run.label).toBe("listing-error");
		expect(JSON.parse(run.stored!.coverage_json)).toMatchObject({ code: "unavailable" });
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("assessment_code_stage_failed"));
		errorLog.mockRestore();
	});
});
