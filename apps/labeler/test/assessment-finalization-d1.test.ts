import { evaluateHydratedListingVisibility } from "@emdash-cms/registry-moderation";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createAssessmentFinalizationProposal } from "../src/assessment/finalization.js";
import { createD1AssessmentLifecycleStore } from "../src/assessment/lifecycle.js";
import type { AssessmentPolicyResolution } from "../src/assessment/policy.js";
import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
import {
	ASSESSMENT_VERSIONS,
	PROFILE_CID,
	PROFILE_URI,
	PUBLISHER_DID,
} from "./assessment-fixtures.js";
import { createTestIssuer, decisionContext, ISSUER_DID } from "./issuer-helpers.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("atomic D1 assessment finalization", () => {
	it("commits the terminal assessment, findings, and signed label once", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const { run, fingerprint } = await createPreparedRun(
			lifecycle,
			"atomic-success",
			PROFILE_URI,
			PROFILE_CID,
		);
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const proposal = createAssessmentFinalizationProposal({
			run,
			moderationFingerprint: fingerprint,
			resolution: reviewResolution(),
		});

		const committed = await issuer.commitAssessmentFinalization(
			proposal,
			new Date("2026-08-24T16:00:00.000Z"),
		);
		const retried = await issuer.commitAssessmentFinalization(
			proposal,
			new Date("2026-08-24T17:00:00.000Z"),
		);

		expect(retried).toEqual(committed);
		expect(committed.run).toMatchObject({ state: "review", stateVersion: run.stateVersion + 1 });
		const assessment = await env.DB.prepare(
			`SELECT state, coverage_json, summary_json
			 FROM assessments WHERE run_key = ?`,
		)
			.bind(run.runKey)
			.first<{ state: string; coverage_json: string; summary_json: string }>();
		expect(assessment?.state).toBe("review");
		expect(JSON.parse(assessment?.coverage_json ?? "null")).toEqual(reviewResolution().coverage);
		expect(JSON.parse(assessment?.summary_json ?? "null")).toMatchObject({
			policyEngineVersion: "listing-assessment-policy-v1",
			reasonCodes: ["policy-finding"],
		});
		const findings = await env.DB.prepare(
			`SELECT category, reason_code, public_summary, evidence_refs_json
			 FROM findings WHERE assessment_id = ? ORDER BY finding_index`,
		)
			.bind(run.runKey)
			.all<{
				category: string;
				reason_code: string;
				public_summary: string;
				evidence_refs_json: string;
			}>();
		expect(findings.results).toEqual([
			{
				category: "scam-or-spam",
				reason_code: "policy-finding",
				public_summary: "The listing contains deceptive promotion.",
				evidence_refs_json: '["profile.description"]',
			},
		]);
		const labels = await env.DB.prepare(
			`SELECT sequence, uri, cid, val, actor_role, assessment_id
			 FROM issued_labels WHERE idempotency_key = ?`,
		)
			.bind(proposal.idempotencyKey)
			.all<{
				sequence: number;
				uri: string;
				cid: string;
				val: string;
				actor_role: string;
				assessment_id: string;
			}>();
		expect(labels.results).toEqual([
			expect.objectContaining({
				sequence: committed.labelSequence,
				uri: PROFILE_URI,
				cid: PROFILE_CID,
				val: "listing-review",
				actor_role: "automation",
				assessment_id: run.runKey,
			}),
		]);
	});

	it("retracts an earlier automated error when a rerun passes", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const uri = `${PROFILE_URI}-rerun-transition`;
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const first = await createPreparedRun(lifecycle, "rerun-transition-error", uri, PROFILE_CID);
		await issuer.commitAssessmentFinalization(
			createAssessmentFinalizationProposal({
				run: first.run,
				moderationFingerprint: first.fingerprint,
				resolution: terminalResolution("error"),
			}),
			new Date("2026-08-24T16:00:00.000Z"),
		);

		const rerun = await createPreparedRun(lifecycle, "rerun-transition-passed", uri, PROFILE_CID);
		const proposal = createAssessmentFinalizationProposal({
			run: rerun.run,
			moderationFingerprint: rerun.fingerprint,
			resolution: terminalResolution("pass"),
		});
		const committed = await issuer.commitAssessmentFinalization(
			proposal,
			new Date("2026-08-24T16:00:00.000Z"),
		);
		const retried = await issuer.commitAssessmentFinalization(
			proposal,
			new Date("2026-08-24T17:00:00.000Z"),
		);

		const stored = await env.DB.prepare(
			`SELECT ver, src, uri, cid, val, neg, cts
			 FROM issued_labels WHERE uri = ? ORDER BY sequence`,
		)
			.bind(uri)
			.all<{
				ver: 1;
				src: string;
				uri: string;
				cid: string;
				val: string;
				neg: number;
				cts: string;
			}>();
		const labels = stored.results.map(({ neg, ...label }) => ({
			...label,
			...(neg === 1 ? { neg: true } : {}),
		}));
		const visibility = evaluateHydratedListingVisibility({
			subject: {
				uri,
				cid: PROFILE_CID,
				kind: "profile",
				publisherDid: PUBLISHER_DID,
			},
			policy: {
				schemaVersion: 1,
				policyVersion: ASSESSMENT_VERSIONS.policyVersion,
				effectiveAt: "2026-08-24T00:00:00.000Z",
				requiredPositiveSources: [ISSUER_DID],
				acceptedStateSources: [],
				redactionSources: [],
				autoPass: "disabled",
				prohibitedCategories: [],
			},
			labels,
			evaluatedAt: "2026-08-24T16:00:01.000Z",
		});

		expect(retried).toEqual(committed);
		expect(labels).toHaveLength(3);
		expect(labels).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ val: "listing-error" }),
				expect.objectContaining({ val: "listing-error", neg: true }),
				expect.objectContaining({ val: "listing-passed" }),
			]),
		);
		expect(visibility).toMatchObject({ visible: true, state: "passed" });
	});

	it("finalizes findings without automated labels after a manual decision wins", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const uri = `${PROFILE_URI}-manual-fence`;
		const { run, fingerprint } = await createPreparedRun(
			lifecycle,
			"manual-fence",
			uri,
			PROFILE_CID,
		);
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const proposal = createAssessmentFinalizationProposal({
			run,
			moderationFingerprint: fingerprint,
			resolution: reviewResolution(),
		});
		await issuer.approve(decisionContext("atomic-manual-fence"), run.subject);

		await expect(
			issuer.commitAssessmentFinalization(proposal, new Date("2026-08-24T16:30:00.000Z")),
		).resolves.toMatchObject({
			run: { state: "review", stateVersion: run.stateVersion + 1 },
			publicationPending: false,
		});
		expect(await lifecycle.getRun(run.runKey)).toMatchObject({ state: "review" });
		const label = await env.DB.prepare("SELECT id FROM issued_labels WHERE idempotency_key = ?")
			.bind(proposal.idempotencyKey)
			.first();
		expect(label).toBeNull();
	});

	it("rolls back both state and label when the prepared fingerprint is stale", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const uri = `${PROFILE_URI}-fingerprint-fence`;
		const { run } = await createPreparedRun(lifecycle, "fingerprint-fence", uri, PROFILE_CID);
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const proposal = createAssessmentFinalizationProposal({
			run,
			moderationFingerprint: "f".repeat(64),
			resolution: reviewResolution(),
		});

		await expect(issuer.commitAssessmentFinalization(proposal)).rejects.toThrow(
			"changed concurrently",
		);
		expect(await lifecycle.getRun(run.runKey)).toMatchObject({ state: "running" });
		expect(
			await env.DB.prepare("SELECT id FROM issued_labels WHERE idempotency_key = ?")
				.bind(proposal.idempotencyKey)
				.first(),
		).toBeNull();
	});

	it("keeps the run prepared when automated issuance is paused", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const uri = `${PROFILE_URI}-paused-finalization`;
		const { run, fingerprint } = await createPreparedRun(
			lifecycle,
			"paused-finalization",
			uri,
			PROFILE_CID,
		);
		await env.DB.prepare(
			`INSERT INTO service_state (key, value, updated_at)
			 VALUES ('issuance_paused', '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1'`,
		)
			.bind("2026-08-24T19:00:00.000Z")
			.run();
		const issuer = await createTestIssuer(env.DB, {
			automationPolicyVersions: [ASSESSMENT_VERSIONS.policyVersion],
		});
		const proposal = createAssessmentFinalizationProposal({
			run,
			moderationFingerprint: fingerprint,
			resolution: reviewResolution(),
		});
		await expect(issuer.commitAssessmentFinalization(proposal)).rejects.toThrow(/paused/);
		expect(await lifecycle.getRun(run.runKey)).toMatchObject({ state: "running" });
		await env.DB.prepare("DELETE FROM service_state WHERE key = 'issuance_paused'").run();
	});
});

function reviewResolution(): AssessmentPolicyResolution {
	return {
		policyEngineVersion: "listing-assessment-policy-v1",
		policyVersion: ASSESSMENT_VERSIONS.policyVersion,
		outcome: "review",
		coverage: { text: "complete", links: "complete", media: "not-present" },
		findings: [
			{
				category: "scam-or-spam",
				recommendation: "review",
				confidence: 0.92,
				summary: "The listing contains deceptive promotion.",
				evidenceRefs: ["profile.description"],
			},
		],
		reasonCodes: ["policy-finding"],
		imageIdentities: [],
	};
}

function terminalResolution(outcome: "pass" | "error"): AssessmentPolicyResolution {
	return {
		policyEngineVersion: "listing-assessment-policy-v1",
		policyVersion: ASSESSMENT_VERSIONS.policyVersion,
		outcome,
		coverage: { text: "complete", links: "complete", media: "complete" },
		findings: [],
		reasonCodes: [],
		imageIdentities: [],
	};
}

async function createPreparedRun(
	lifecycle: ReturnType<typeof createD1AssessmentLifecycleStore>,
	logicalTriggerId: string,
	uri: string,
	cid: string,
) {
	const params = await createAssessmentWorkflowParams({
		subject: { uri, cid, kind: "profile" },
		versions: ASSESSMENT_VERSIONS,
		logicalTriggerId,
	});
	await lifecycle.observeRun({ params, observedAt: "2026-08-24T15:00:00.000Z" });
	const started = await lifecycle.startRun(params.runKey, 0, "2026-08-24T15:00:01.000Z");
	const fingerprint = `fingerprint:${logicalTriggerId}`;
	const run = await lifecycle.persistPrepared(
		params.runKey,
		started.stateVersion,
		{
			moderationFingerprint: fingerprint,
			canonicalInput: { schemaVersion: 1 },
			coverage: { text: "complete", links: "complete", media: "not-present" },
		},
		"2026-08-24T15:00:02.000Z",
	);
	return { run, fingerprint };
}
