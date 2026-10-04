import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
	AssessmentStateConflictError,
	createD1AssessmentLifecycleStore,
} from "../src/assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
import type { AssessmentVersionSet } from "../src/assessment/types.js";
import { ASSESSMENT_VERSIONS, PROFILE_CID, PROFILE_URI } from "./assessment-fixtures.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("authoritative assessment lifecycle", () => {
	it("observes duplicate runs once and makes transitions idempotent across step retries", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:100",
		});
		const first = await lifecycle.observeRun({ params, observedAt: "2026-08-24T10:00:00.000Z" });
		const duplicate = await lifecycle.observeRun({
			params,
			observedAt: "2026-08-24T10:00:01.000Z",
		});
		expect(first).toMatchObject({ state: "pending", stateVersion: 0 });
		expect(duplicate).toMatchObject({ runKey: params.runKey, state: "pending" });
		const count = await env.DB.prepare(
			`SELECT COUNT(*) AS count FROM assessments WHERE run_key = ?`,
		)
			.bind(params.runKey)
			.first<{ count: number }>();
		expect(count?.count).toBe(1);

		const started = await lifecycle.startRun(params.runKey, 0, "2026-08-24T10:00:02.000Z");
		const retriedStart = await lifecycle.startRun(params.runKey, 0, "2026-08-24T10:00:03.000Z");
		expect(started).toMatchObject({ state: "running", stateVersion: 1 });
		expect(retriedStart).toEqual(started);
		const prepared = {
			moderationFingerprint: "sha256:prepared",
			canonicalInput: { schemaVersion: 1, subject: { uri: PROFILE_URI, cid: PROFILE_CID } },
			coverage: { text: "complete", links: "not-present", media: "not-present" },
		};
		const stored = await lifecycle.persistPrepared(
			params.runKey,
			started.stateVersion,
			prepared,
			"2026-08-24T10:00:04.000Z",
		);
		const retriedStore = await lifecycle.persistPrepared(
			params.runKey,
			started.stateVersion,
			prepared,
			"2026-08-24T10:00:05.000Z",
		);
		expect(stored).toMatchObject({ state: "running", stateVersion: 2 });
		expect(retriedStore).toEqual(stored);
		await expect(
			lifecycle.persistPrepared(
				params.runKey,
				0,
				{ ...prepared, moderationFingerprint: "sha256:different" },
				"2026-08-24T10:00:06.000Z",
			),
		).rejects.toBeInstanceOf(AssessmentStateConflictError);
		const finalized = await lifecycle.finalizeRun(
			params.runKey,
			stored.stateVersion,
			"passed",
			"2026-08-24T10:00:07.000Z",
		);
		const retriedFinalization = await lifecycle.finalizeRun(
			params.runKey,
			stored.stateVersion,
			"passed",
			"2026-08-24T10:00:08.000Z",
		);
		expect(retriedFinalization).toEqual(finalized);
		await expect(
			lifecycle.finalizeRun(
				params.runKey,
				stored.stateVersion,
				"review",
				"2026-08-24T10:00:09.000Z",
			),
		).rejects.toBeInstanceOf(AssessmentStateConflictError);
	});

	it("prevents deletion or a newer CID from reaching positive finalization", async () => {
		const deletionCid = `${PROFILE_CID.slice(0, -4)}dlte`;
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const deletedParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: deletionCid, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:delete-case",
		});
		await lifecycle.observeRun({
			params: deletedParams,
			observedAt: "2026-08-24T11:00:00.000Z",
		});
		const started = await lifecycle.startRun(deletedParams.runKey, 0, "2026-08-24T11:00:01.000Z");
		await lifecycle.cancelSubject(PROFILE_URI, "2026-08-24T11:00:02.000Z");
		const deleted = await lifecycle.persistPrepared(
			deletedParams.runKey,
			started.stateVersion,
			{
				moderationFingerprint: "sha256:deleted",
				canonicalInput: {},
				coverage: {},
			},
			"2026-08-24T11:00:03.000Z",
		);
		expect(deleted.state).toBe("cancelled");
		expect(await lifecycle.getRun(deletedParams.runKey)).toMatchObject({
			state: "cancelled",
			deleted: true,
		});

		const oldCid = `${deletionCid.slice(0, -1)}c`;
		const oldParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: oldCid, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:old-cid",
		});
		await lifecycle.observeRun({ params: oldParams, observedAt: "2026-08-24T12:00:00.000Z" });
		const oldStarted = await lifecycle.startRun(oldParams.runKey, 0, "2026-08-24T12:00:01.000Z");
		const newParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: deletionCid, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:new-cid",
		});
		await lifecycle.observeRun({ params: newParams, observedAt: "2026-08-24T12:00:02.000Z" });
		const superseded = await lifecycle.persistPrepared(
			oldParams.runKey,
			oldStarted.stateVersion,
			{
				moderationFingerprint: "sha256:old",
				canonicalInput: {},
				coverage: {},
			},
			"2026-08-24T12:00:03.000Z",
		);
		expect(superseded.state).toBe("superseded");
	});

	it("rechecks the current CID atomically when finalizing a prepared run", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const oldCid = `${PROFILE_CID.slice(0, -1)}d`;
		const oldParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: oldCid, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:prepared-old-cid",
		});
		await lifecycle.observeRun({ params: oldParams, observedAt: "2026-08-24T13:00:00.000Z" });
		const started = await lifecycle.startRun(oldParams.runKey, 0, "2026-08-24T13:00:01.000Z");
		const prepared = await lifecycle.persistPrepared(
			oldParams.runKey,
			started.stateVersion,
			{
				moderationFingerprint: "sha256:prepared-old",
				canonicalInput: {},
				coverage: {},
			},
			"2026-08-24T13:00:02.000Z",
		);
		const newParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:current-new-cid",
		});
		await lifecycle.observeRun({ params: newParams, observedAt: "2026-08-24T13:00:03.000Z" });
		await expect(
			lifecycle.finalizeRun(
				oldParams.runKey,
				prepared.stateVersion,
				"passed",
				"2026-08-24T13:00:04.000Z",
			),
		).rejects.toBeInstanceOf(AssessmentStateConflictError);
		expect(await lifecycle.getRun(oldParams.runKey)).toMatchObject({ state: "running" });
	});
});

describe("assessment run origins", () => {
	const versionCid = (suffix: string) => `${PROFILE_CID.slice(0, -4)}${suffix}`;

	async function decide(cid: string, trigger: string, outcome: "passed" | "review") {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: trigger,
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-25T09:00:00.000Z" });
		const started = await lifecycle.startRun(params.runKey, 0, "2026-08-25T09:00:01.000Z");
		const prepared = await lifecycle.persistPrepared(
			params.runKey,
			started.stateVersion,
			{ moderationFingerprint: `sha256:${trigger}`, canonicalInput: {}, coverage: {} },
			"2026-08-25T09:00:02.000Z",
		);
		await lifecycle.finalizeRun(
			params.runKey,
			prepared.stateVersion,
			outcome,
			"2026-08-25T09:00:03.000Z",
		);
		return params.runKey;
	}

	async function paramsFor(
		cid: string,
		trigger: string,
		versions: AssessmentVersionSet = ASSESSMENT_VERSIONS,
	) {
		return createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid, kind: "profile" },
			versions,
			logicalTriggerId: trigger,
		});
	}

	async function currentAssessment(cid: string) {
		return env.DB.prepare(
			"SELECT assessment_id FROM current_assessments WHERE subject_uri = ? AND subject_cid = ?",
		)
			.bind(PROFILE_URI, cid)
			.first<string>("assessment_id");
	}

	async function runExists(runKey: string) {
		return (
			(await env.DB.prepare("SELECT 1 AS found FROM assessments WHERE run_key = ?")
				.bind(runKey)
				.first<number>("found")) === 1
		);
	}

	it("never re-assesses a decided listing version after the model changes", async () => {
		const cid = versionCid("dcda");
		const decided = await decide(cid, "event:decided", "passed");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const changedModel = await paramsFor(cid, "authoritative:after-model-change", {
			...ASSESSMENT_VERSIONS,
			textModelId: "@cf/example/another-model",
		});

		const observed = await lifecycle.observeRun({
			params: changedModel,
			observedAt: "2026-08-25T10:00:00.000Z",
		});

		expect(observed).toBeNull();
		expect(await runExists(changedModel.runKey)).toBe(false);
		expect(await currentAssessment(cid)).toBe(decided);
	});

	it("keeps a listing version held for review held", async () => {
		const cid = versionCid("dcra");
		const held = await decide(cid, "event:held", "review");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);

		const observed = await lifecycle.observeRun({
			params: await paramsFor(cid, "event:redelivered"),
			observedAt: "2026-08-25T10:00:00.000Z",
		});

		expect(observed).toBeNull();
		expect(await currentAssessment(cid)).toBe(held);
	});

	it("does not start a run for a listing version an operator decided", async () => {
		const cid = versionCid("opda");
		await env.DB.prepare(
			`INSERT INTO operator_actions
			   (actor_did, actor_role, action, subject_uri, subject_cid, reason, idempotency_key, created_at)
			 VALUES ('did:web:operator.example', 'admin', 'approve', ?, ?, '', 'approve-opda', ?)`,
		)
			.bind(PROFILE_URI, cid, "2026-08-25T09:00:00.000Z")
			.run();
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await paramsFor(cid, "event:after-approval");

		expect(
			await lifecycle.observeRun({ params, observedAt: "2026-08-25T10:00:00.000Z" }),
		).toBeNull();
		expect(await runExists(params.runKey)).toBe(false);
	});

	it("lets only the first of two automated triggers assess a new listing version", async () => {
		const cid = versionCid("raca");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const reconciliation = await paramsFor(cid, "reconciliation:first");
		const authoritative = await paramsFor(cid, "authoritative:second");

		const [first, second] = await Promise.all([
			lifecycle.observeRun({ params: reconciliation, observedAt: "2026-08-25T10:00:00.000Z" }),
			lifecycle.observeRun({ params: authoritative, observedAt: "2026-08-25T10:00:00.000Z" }),
		]);

		expect([first, second].filter((run) => run !== null)).toHaveLength(1);
		const winner = first ? reconciliation.runKey : authoritative.runKey;
		expect(await currentAssessment(cid)).toBe(winner);
	});

	it("does not dispatch a run again once it has finished", async () => {
		const cid = versionCid("fina");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		await decide(cid, "authoritative:deterministic", "passed");

		expect(
			await lifecycle.observeRun({
				params: await paramsFor(cid, "authoritative:deterministic"),
				observedAt: "2026-08-25T10:00:00.000Z",
			}),
		).toBeNull();
	});

	it("lets an operator re-assess a decided listing version deliberately", async () => {
		const cid = versionCid("orra");
		await decide(cid, "event:operator-decided", "passed");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await paramsFor(cid, "operator:rerun");

		const observed = await lifecycle.observeRun({
			params,
			observedAt: "2026-08-25T10:00:00.000Z",
			makeCurrent: false,
			origin: { kind: "operator" },
		});

		expect(observed).toMatchObject({ runKey: params.runKey, state: "pending" });
		expect(await currentAssessment(cid)).toBe(params.runKey);
	});

	it("supersedes an abandoned run on a decided listing version and restores the decision", async () => {
		const cid = versionCid("orpa");
		const decided = await decide(cid, "event:orphan-decided", "passed");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const orphan = await paramsFor(cid, "operator:orphan");
		await lifecycle.observeRun({
			params: orphan,
			observedAt: "2026-08-25T10:00:00.000Z",
			origin: { kind: "operator" },
		});
		await lifecycle.startRun(orphan.runKey, 0, "2026-08-25T10:00:01.000Z");

		expect(await lifecycle.supersedeAbandonedRun(orphan.runKey, "2026-08-25T11:00:00.000Z")).toBe(
			true,
		);
		expect(await lifecycle.getRun(orphan.runKey)).toMatchObject({ state: "superseded" });
		expect(await currentAssessment(cid)).toBe(decided);
	});

	it("lets an undecided listing version be assessed again once its abandoned run is superseded", async () => {
		const cid = versionCid("unda");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const abandoned = await paramsFor(cid, "event:abandoned");
		await lifecycle.observeRun({ params: abandoned, observedAt: "2026-08-25T10:00:00.000Z" });
		const replacement = await paramsFor(cid, "recovery:replacement");
		expect(
			await lifecycle.observeRun({ params: replacement, observedAt: "2026-08-25T10:30:00.000Z" }),
		).toBeNull();

		expect(
			await lifecycle.supersedeAbandonedRun(abandoned.runKey, "2026-08-25T11:00:00.000Z"),
		).toBe(true);

		expect(await lifecycle.getRun(abandoned.runKey)).toMatchObject({ state: "superseded" });
		expect(
			await lifecycle.observeRun({ params: replacement, observedAt: "2026-08-25T11:00:01.000Z" }),
		).toMatchObject({ runKey: replacement.runKey, state: "pending" });
	});

	it("does not supersede a run that has already finished", async () => {
		const cid = versionCid("dnea");
		const finished = await decide(cid, "event:finished", "passed");
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);

		expect(await lifecycle.supersedeAbandonedRun(finished, "2026-08-25T11:00:00.000Z")).toBe(false);
		expect(await lifecycle.getRun(finished)).toMatchObject({ state: "passed" });
	});
});
