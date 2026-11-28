import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { parseRequest } from "../../plugin-review/src/request.js";
import type { OperatorIdentity } from "../src/access.js";
import { buildCanonicalProfileInput } from "../src/assessment/canonical.js";
import { createD1AssessmentLifecycleStore } from "../src/assessment/lifecycle.js";
import { ByteLimitExceededError } from "../src/assessment/media.js";
import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
import { runBoundAssessmentWorkflow, type CodeAssessmentStep } from "../src/assessment/workflow.js";
import type { CodeAssessmentDependencies, PluginReviewRequest } from "../src/code/assessment.js";
import type { ReviewBudget } from "../src/code/budget.js";
import { handleOperatorApi, type OperatorApiDependencies } from "../src/operator/api.js";
import {
	PUBLISHER_NOTIFICATION_SENDER,
	readPublisherNotification,
	type PublisherEmailSender,
} from "../src/operator/publisher-notification.js";
import {
	ASSESSMENT_VERSIONS,
	PROFILE_CID,
	PROFILE_RECORD,
	PROFILE_URI,
	RELEASE_CID,
	RELEASE_URI,
	createReleaseRecord,
} from "./assessment-fixtures.js";
import { checksumOf, cleanBundleEntries, createBundle } from "./code-fixtures.js";
import { createTestIssuer } from "./issuer-helpers.js";

class CachedStep implements CodeAssessmentStep {
	readonly calls: string[] = [];
	readonly sleeps: string[] = [];
	readonly #results = new Map<string, unknown>();

	async do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	async do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
	async do<T>(
		name: string,
		configOrCallback: WorkflowStepConfig | (() => Promise<T>),
		maybeCallback?: () => Promise<T>,
	): Promise<T> {
		const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback!;
		if (this.#results.has(name)) return this.#results.get(name) as T;
		this.calls.push(name);
		const result = await callback();
		this.#results.set(name, result);
		return result;
	}

	async sleepUntil(name: string): Promise<void> {
		this.sleeps.push(name);
	}
}

const MODELS = ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"];

function cleanReview(request: PluginReviewRequest) {
	return {
		model: request.model,
		promptVersion: "plugin-review-v1",
		summary: "Clean.",
		findings: [],
	};
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
	review?: (request: PluginReviewRequest) => Promise<unknown>;
	budget?: ReviewBudget;
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
	const requests: PluginReviewRequest[] = [];
	const codeAssessment: CodeAssessmentDependencies = {
		bundleReader: { read: options.readBundle ?? (async () => options.bundle) },
		profiles: {
			async currentCid(uri) {
				return uri === PROFILE_URI ? PROFILE_CID : null;
			},
		},
		reviewer: {
			async review(request) {
				parseRequest(request);
				requests.push(request);
				return (options.review ?? (async (input) => cleanReview(input)))(request);
			},
		},
		models: MODELS,
		...(options.budget ? { budget: options.budget } : {}),
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
				async verifyExactRecord(subject) {
					if (subject.kind === "profile") {
						return {
							uri: PROFILE_URI,
							cid: PROFILE_CID,
							record: PROFILE_RECORD,
							verification: "did-mst-signature" as const,
						};
					}
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
		`SELECT category, severity, public_summary, evidence_refs_json, source, excerpts_json
		 FROM findings WHERE assessment_id = ? ORDER BY finding_index`,
	)
		.bind(params.runKey)
		.all<{
			category: string;
			severity: string;
			public_summary: string;
			evidence_refs_json: string;
			source: string | null;
			excerpts_json: string | null;
		}>();
	return { result, step, stored, label, findings: findings.results, requests, params };
}

describe("release code assessment in the assessment Workflow", () => {
	it("passes a package that every reviewer finds clean and records the reviewers", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}clna`,
			bundle: await createBundle(cleanBundleEntries()),
		});
		expect(run.result.status).toBe("passed");
		expect(run.label).toBe("listing-passed");
		expect(run.step.calls).toEqual(
			expect.arrayContaining([
				"verify and project release package",
				"check release package",
				`review release package with ${MODELS[0]}`,
				`review release package with ${MODELS[1]}`,
			]),
		);
		expect(JSON.parse(run.stored!.coverage_json)).toMatchObject({ code: "complete" });
		expect(JSON.parse(run.stored!.summary_json).codeIdentity).toEqual({
			reviewers: MODELS.map((model) => ({ model, promptVersion: "plugin-review-v1" })),
		});
		expect(run.requests.map(({ model }) => model).toSorted()).toEqual(MODELS.toSorted());
		expect(run.requests[0]).toMatchObject({
			subject: { uri: RELEASE_URI, version: "1.2.3" },
			declaredAccess: { network: { request: { allowedHosts: ["api.example.com"] } } },
		});
		expect(run.requests[0]?.listing).toContainEqual({
			ref: "profile.description",
			text: PROFILE_RECORD.description,
		});
		expect(run.requests[0]?.files.find(({ path }) => path === "backend.js")?.text).toContain(
			"export default",
		);
	});

	it("holds a package for review when one reviewer reports a finding", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}reva`,
			bundle: await createBundle(cleanBundleEntries()),
			review: async (request) =>
				request.model === MODELS[1]
					? {
							...cleanReview(request),
							findings: [
								{
									category: "vulnerability",
									severity: "high",
									confidence: 0.8,
									summary: "A public route returns draft posts.",
									evidence: [{ file: "backend.js", line: 1, quote: "export default" }],
								},
							],
						}
					: cleanReview(request),
		});
		expect(run.result.status).toBe("review");
		expect(run.label).toBe("listing-review");
		expect(run.findings).toMatchObject([
			{
				category: "vulnerability",
				severity: "high",
				public_summary: "A public route returns draft posts.",
			},
		]);
		expect(JSON.parse(run.findings[0]!.evidence_refs_json)).toEqual([
			"release.package:backend.js#L1",
		]);
	});

	it("records which reviewer raised a finding, the cited code, and each reviewer's conclusion", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}srca`,
			bundle: await createBundle(cleanBundleEntries()),
			review: async (request) =>
				request.model === MODELS[1]
					? {
							...cleanReview(request),
							summary: "One public route leaks drafts.",
							findings: [
								{
									category: "vulnerability",
									severity: "high",
									confidence: 0.8,
									summary: "A public route returns draft posts.",
									evidence: [{ file: "backend.js", line: 1, quote: "misquoted" }],
								},
							],
						}
					: cleanReview(request),
		});
		const backend = run.requests[0]!.files.find(({ path }) => path === "backend.js")!.text!;
		expect(run.findings[0]!.source).toBe(MODELS[1]);
		expect(JSON.parse(run.findings[0]!.excerpts_json!)).toEqual([
			{
				ref: "release.package:backend.js#L1",
				startLine: 1,
				lines: backend.split("\n").slice(0, 4),
			},
		]);
		expect(JSON.parse(run.stored!.summary_json).codeReviews).toEqual([
			{ model: MODELS[0], promptVersion: "plugin-review-v1", summary: "Clean.", findingCount: 0 },
			{
				model: MODELS[1],
				promptVersion: "plugin-review-v1",
				summary: "One public route leaks drafts.",
				findingCount: 1,
			},
		]);
	});

	it("holds a package for review and keeps other findings when a reviewer declines", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}deca`,
			bundle: await createBundle(cleanBundleEntries()),
			review: async (request) =>
				request.model === MODELS[0]
					? {
							...cleanReview(request),
							summary: "Safeguards flagged this message.",
							declined: true,
						}
					: {
							...cleanReview(request),
							findings: [
								{
									category: "malicious-code",
									severity: "critical",
									confidence: 0.9,
									summary: "Sends post content to an undisclosed host.",
									evidence: [{ file: "backend.js", line: 1, quote: "export default" }],
								},
							],
						},
		});
		expect(run.result.status).toBe("review");
		expect(run.label).toBe("listing-review");
		expect(run.findings.map(({ category }) => category).toSorted()).toEqual([
			"malicious-code",
			"review-declined",
		]);
		expect(
			run.findings.find(({ category }) => category === "review-declined")?.public_summary,
		).toContain("Safeguards flagged this message.");
	});

	it("reports archive anomalies as findings and still runs the review", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}anma`,
			bundle: await createBundle([
				...cleanBundleEntries(),
				{ name: "../../escape.js", content: "x" },
			]),
		});
		expect(run.result.status).toBe("review");
		expect(run.findings).toMatchObject([{ category: "package-integrity", severity: "critical" }]);
		expect(run.requests).toHaveLength(MODELS.length);
	});

	it.each([
		["invalid-gzip", async () => new Uint8Array([1, 2, 3, 4]), "bada"],
		[
			"duplicate-entry",
			async () =>
				createBundle([...cleanBundleEntries(), { name: "backend.js", content: "export {};" }]),
			"dupe",
		],
	])(
		"holds a package with %s for review without asking reviewers to read it",
		async (code, bundle, suffix) => {
			const run = await runRelease({
				cid: `${RELEASE_CID.slice(0, -4)}${suffix}`,
				bundle: await bundle(),
			});
			expect(run.result.status).toBe("review");
			expect(run.findings.map(({ public_summary }) => public_summary)).toEqual([
				expect.stringContaining(`bundle.${code}`),
			]);
			expect(run.requests).toEqual([]);
		},
	);

	it("reports a package over the size limit as a finding", async () => {
		const bundle = await createBundle(cleanBundleEntries());
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}biga`,
			bundle,
			readBundle: async () => {
				throw new ByteLimitExceededError("too large");
			},
		});
		expect(run.result.status).toBe("review");
		expect(run.findings.map(({ public_summary }) => public_summary)).toEqual([
			expect.stringContaining("bundle.compressed-size-exceeded"),
		]);
		expect(run.requests).toEqual([]);
	});

	it("keeps archive findings when a reviewer fails", async () => {
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}kpfa`,
			bundle: await createBundle([...cleanBundleEntries(), { name: "extra.txt", content: "x" }]),
			review: async () => {
				throw new Error("reviewer unavailable");
			},
		});
		expect(run.result.status).toBe("error");
		expect(run.findings.map(({ category }) => category)).toEqual(["package-integrity"]);
	});

	it("waits for review budget instead of skipping the review", async () => {
		let attempts = 0;
		const run = await runRelease({
			cid: `${RELEASE_CID.slice(0, -4)}buda`,
			bundle: await createBundle(cleanBundleEntries()),
			budget: {
				async reserve() {
					attempts += 1;
					return attempts === 1
						? { reserved: false, retryAt: "2026-11-17T00:00:00.000Z" }
						: { reserved: true };
				},
			},
		});
		expect(run.result.status).toBe("passed");
		expect(run.step.sleeps).toEqual(["wait for package review budget (0)"]);
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
		[
			"a reviewer fails",
			"erca",
			async () => ({ review: async () => Promise.reject(new Error("gateway down")) }),
		],
		[
			"a reviewer cites a line outside the bundle",
			"erda",
			async () => ({
				review: async (request: PluginReviewRequest) => ({
					...cleanReview(request),
					findings: [
						{
							category: "malicious-code",
							severity: "critical",
							confidence: 0.9,
							summary: "Invented.",
							evidence: [{ file: "backend.js", line: 99, quote: "nothing" }],
						},
					],
				}),
			}),
		],
		[
			"the review budget stays exhausted",
			"erea",
			async () => ({
				budget: {
					reserve: async () => ({ reserved: false as const, retryAt: "2026-11-17T00:00:00.000Z" }),
				},
			}),
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

const ADMIN: OperatorIdentity = {
	kind: "human",
	email: "admin@example.com",
	sub: "access-admin",
	roles: ["admin"],
};

async function seedProfile(security: readonly { url?: `${string}:${string}`; email?: string }[]) {
	const canonical = buildCanonicalProfileInput({
		kind: "profile",
		uri: PROFILE_URI,
		cid: PROFILE_CID,
		record: { ...PROFILE_RECORD, security: [...security] },
		verification: "did-mst-signature",
	});
	const now = "2026-11-16T09:00:00.000Z";
	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO subjects (uri, cid, kind, publisher_did, first_observed_at, last_observed_at)
			 VALUES (?, ?, 'profile', ?, ?, ?)`,
		).bind(PROFILE_URI, PROFILE_CID, "did:plc:assessmentfixture00000000", now, now),
		env.DB.prepare(
			`INSERT INTO current_subjects (uri, cid, kind, updated_at) VALUES (?, ?, 'profile', ?)
			 ON CONFLICT (uri) DO UPDATE SET cid = excluded.cid`,
		).bind(PROFILE_URI, PROFILE_CID, now),
		env.DB.prepare("DELETE FROM assessments WHERE run_key = 'profile-fixture'"),
		env.DB.prepare(
			`INSERT INTO assessments (
				id, run_key, subject_uri, subject_cid, subject_kind, policy_version, parser_version,
				text_model_id, text_prompt_hash, image_model_id, image_prompt_hash, logical_trigger_id,
				state, canonical_input_json, created_at, updated_at
			 ) VALUES ('profile-fixture', 'profile-fixture', ?, ?, 'profile', 'p', 'p', 'm', 'h', 'm', 'h', 't',
				'passed', ?, ?, ?)`,
		).bind(PROFILE_URI, PROFILE_CID, JSON.stringify(canonical), now, now),
	]);
}

function notifyRequest(runKey: string, body: Record<string, unknown>, key = crypto.randomUUID()) {
	return new Request(
		`https://labels.example/_admin/api/assessments/${encodeURIComponent(runKey)}/notify-publisher`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://labels.example",
				"X-EmDash-Request": "1",
				"Idempotency-Key": key,
			},
			body: JSON.stringify(body),
		},
	);
}

function notifyDependencies(
	identity: OperatorIdentity,
	publisherEmail: PublisherEmailSender,
): OperatorApiDependencies {
	const lifecycle = createD1AssessmentLifecycleStore(env.DB);
	return {
		authenticate: async () => identity,
		actorDid: async () => "did:web:labels.emdashcms.com:operators:fixture",
		getRun: (runKey) => lifecycle.getRun(runKey),
		isCurrentSubject: async () => true,
		issuer: {
			approve: async () => Promise.reject(new Error("unused")),
			block: async () => Promise.reject(new Error("unused")),
			issue: async () => Promise.reject(new Error("unused")),
		},
		rerun: async () => Promise.reject(new Error("unused")),
		publisherEmail,
		now: () => new Date("2026-11-16T11:00:00.000Z"),
	};
}

function recordingSender(failures = 0) {
	const sent: Parameters<PublisherEmailSender["send"]>[0][] = [];
	let remainingFailures = failures;
	const sender: PublisherEmailSender = {
		async send(message) {
			if (remainingFailures > 0) {
				remainingFailures -= 1;
				throw Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" });
			}
			sent.push(message);
			return { messageId: `message-${sent.length}` };
		},
	};
	return { sender, sent };
}

async function heldRelease(suffix: string) {
	const cid = `${RELEASE_CID.slice(0, -4)}${suffix}`;
	return {
		cid,
		...(await runRelease({
			cid,
			bundle: await createBundle([
				...cleanBundleEntries(),
				{ name: "../../escape.js", content: "x" },
			]),
			review: async (request) => ({
				...cleanReview(request),
				findings: [
					{
						category: "vulnerability",
						severity: "high",
						confidence: 0.8,
						summary: "A public route returns <draft> posts.",
						evidence: [{ file: "backend.js", line: 1, quote: "export default" }],
					},
				],
			}),
		})),
	};
}

describe("notifying the publisher about code findings", () => {
	it("emails the package's security contacts once per assessment", async () => {
		await seedProfile([
			{ email: "security@example.test" },
			{ email: "SECURITY@example.test" },
			{ url: "https://example.test/security" },
			{ email: "bad@example.test\nBcc: victim@example.test" },
		]);
		const run = await heldRelease("ntaa");
		const { sender, sent } = recordingSender();
		const body = { uri: RELEASE_URI, cid: run.cid, reason: "Share findings" };
		const key = crypto.randomUUID();

		const response = await handleOperatorApi(
			notifyRequest(run.params.runKey, body, key),
			env,
			notifyDependencies(ADMIN, sender),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			action: "notify-publisher",
			recipients: ["security@example.test"],
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			to: ["security@example.test"],
			from: PUBLISHER_NOTIFICATION_SENDER,
			subject: "Review findings for Gallery 1.2.3 on the EmDash plugin registry",
		});
		expect(sent[0]?.text).toContain("Vulnerability (high severity)");
		expect(sent[0]?.text).toContain("Evidence: backend.js line 1");
		expect(sent[0]?.text).toContain("Package integrity (critical severity)");
		expect(sent[0]?.text).not.toContain("Share findings");
		expect(sent[0]?.text).not.toContain("0.8");
		expect(sent[0]?.html).toContain("A public route returns &lt;draft&gt; posts.");
		expect(sent[0]?.html).not.toContain("<draft>");
		expect(await readPublisherNotification(env.DB, run.params.runKey)).toMatchObject({
			status: "sent",
			recipients: ["security@example.test"],
		});

		const replay = await handleOperatorApi(
			notifyRequest(run.params.runKey, body, key),
			env,
			notifyDependencies(ADMIN, sender),
		);
		expect(replay.status).toBe(200);
		const again = await handleOperatorApi(
			notifyRequest(run.params.runKey, body),
			env,
			notifyDependencies(ADMIN, sender),
		);
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ error: { code: "ALREADY_NOTIFIED" } });
		expect(sent).toHaveLength(1);
	});

	it("records a failed send and lets the operator retry", async () => {
		await seedProfile([{ email: "security@example.test" }]);
		const run = await heldRelease("ntba");
		const { sender, sent } = recordingSender(1);
		const body = { uri: RELEASE_URI, cid: run.cid, reason: "Share findings" };
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const failed = await handleOperatorApi(
			notifyRequest(run.params.runKey, body),
			env,
			notifyDependencies(ADMIN, sender),
		);
		expect(failed.status).toBe(502);
		expect(await readPublisherNotification(env.DB, run.params.runKey)).toMatchObject({
			status: "failed",
			errorCode: "E_RATE_LIMIT_EXCEEDED",
		});
		errorLog.mockRestore();

		const retried = await handleOperatorApi(
			notifyRequest(run.params.runKey, body),
			env,
			notifyDependencies(ADMIN, sender),
		);
		expect(retried.status).toBe(200);
		expect(sent).toHaveLength(1);
	});

	it.each([
		[
			"a reviewer",
			{ ...ADMIN, roles: ["reviewer"] } satisfies OperatorIdentity,
			"ntca",
			403,
			"FORBIDDEN",
		],
		["no security email", ADMIN, "ntda", 409, "NO_SECURITY_CONTACT"],
	] as const)("refuses to send for %s", async (_name, identity, suffix, status, code) => {
		await seedProfile(
			code === "NO_SECURITY_CONTACT"
				? [{ url: "https://example.test/security" }]
				: [{ email: "security@example.test" }],
		);
		const run = await heldRelease(suffix);
		const { sender, sent } = recordingSender();

		const response = await handleOperatorApi(
			notifyRequest(run.params.runKey, { uri: RELEASE_URI, cid: run.cid, reason: "x" }),
			env,
			notifyDependencies(identity, sender),
		);

		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ error: { code } });
		expect(sent).toEqual([]);
	});

	it("refuses to send when the assessment has no code findings", async () => {
		await seedProfile([{ email: "security@example.test" }]);
		const cid = `${RELEASE_CID.slice(0, -4)}ntea`;
		const run = {
			cid,
			...(await runRelease({ cid, bundle: await createBundle(cleanBundleEntries()) })),
		};
		const { sender, sent } = recordingSender();

		const response = await handleOperatorApi(
			notifyRequest(run.params.runKey, { uri: RELEASE_URI, cid: run.cid, reason: "x" }),
			env,
			notifyDependencies(ADMIN, sender),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "NO_CODE_FINDINGS" } });
		expect(sent).toEqual([]);
	});
});
