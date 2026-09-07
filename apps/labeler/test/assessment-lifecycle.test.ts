import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
	AssessmentStateConflictError,
	createD1AssessmentLifecycleStore,
} from "../src/assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
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
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const deletedParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
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

		const oldCid = `${PROFILE_CID.slice(0, -1)}c`;
		const oldParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: oldCid, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:old-cid",
		});
		await lifecycle.observeRun({ params: oldParams, observedAt: "2026-08-24T12:00:00.000Z" });
		const oldStarted = await lifecycle.startRun(oldParams.runKey, 0, "2026-08-24T12:00:01.000Z");
		const newParams = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
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
