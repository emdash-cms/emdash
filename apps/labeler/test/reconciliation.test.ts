import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AssessmentWorkflowBinding } from "../src/assessment/dispatch.js";
import { createD1AssessmentLifecycleStore } from "../src/assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
import type { AssessmentSubject, AssessmentWorkflowParams } from "../src/assessment/types.js";
import { quarantineDiscoveryDeadLetters } from "../src/discovery/queue.js";
import {
	createD1LabelerReconciliationStore,
	reconcileLabeler,
	type ReconciliationWorkflowPresence,
} from "../src/reconciliation/index.js";
import { repairLabelerReconciliationFindings } from "../src/reconciliation/repair.js";
import { ASSESSMENT_VERSIONS, PROFILE_CID, PUBLISHER_DID } from "./assessment-fixtures.js";

const LABELER_DID = "did:web:labeler.example";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM findings"),
		env.DB.prepare("DELETE FROM current_assessments"),
		env.DB.prepare("DELETE FROM assessments"),
		env.DB.prepare("DELETE FROM current_subjects"),
		env.DB.prepare("DELETE FROM subjects"),
		env.DB.prepare("DELETE FROM discovery_quarantine"),
		env.DB.prepare("DELETE FROM discovery_quarantine_events"),
	]);
});

describe("labeler reconciliation", () => {
	it("repairs a missing assessment once and resumes without duplicating its Workflow", async () => {
		const subject = subjectFixture(1);
		await seedCurrentSubject(subject, "2026-08-24T10:00:00.000Z");
		const workflow = createWorkflowHarness();
		const dependencies = dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z"));

		const first = await reconcileLabeler(dependencies);

		expect(first.repairCandidates).toEqual([subject]);
		expect(first.ensuredRunKeys).toHaveLength(1);
		expect(first.dispatchedRunKeys).toEqual(first.ensuredRunKeys);
		expect(workflow.batches).toHaveLength(1);
		expect(workflow.batches[0]).toHaveLength(1);
		const stored = await env.DB.prepare("SELECT run_key, logical_trigger_id FROM assessments").all<{
			run_key: string;
			logical_trigger_id: string;
		}>();
		expect(stored.results).toEqual([
			{
				run_key: first.ensuredRunKeys[0],
				logical_trigger_id: expect.stringMatching(/^reconciliation-v1-[a-f0-9]{64}$/),
			},
		]);

		const resumed = await reconcileLabeler(dependencies);

		expect(resumed.ensuredRunKeys).toEqual(first.ensuredRunKeys);
		expect(resumed.dispatchedRunKeys).toEqual([]);
		expect(resumed.existingWorkflowRunKeys).toEqual(first.ensuredRunKeys);
		expect(workflow.batches).toHaveLength(1);
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS count FROM assessments").first<number>("count"),
		).toBe(1);
	});

	it("restarts a failed Workflow instead of treating it as healthy presence", async () => {
		const subject = subjectFixture(4);
		await seedCurrentSubject(subject, "2026-08-24T10:00:00.000Z");
		const workflow = createWorkflowHarness("restartable");

		const report = await reconcileLabeler(
			dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
		);

		expect(report.restartedWorkflowRunKeys).toEqual(report.ensuredRunKeys);
		expect(report.existingWorkflowRunKeys).toEqual([]);
		expect(workflow.restarts).toEqual(report.ensuredRunKeys);
		expect(workflow.batches).toEqual([]);
	});

	it("ignores deleted current subjects", async () => {
		const subject = subjectFixture(2);
		await seedCurrentSubject(subject, "2026-08-24T10:00:00.000Z");
		await env.DB.batch([
			env.DB.prepare("UPDATE subjects SET deleted_at = ? WHERE uri = ? AND cid = ?").bind(
				"2026-08-24T10:01:00.000Z",
				subject.uri,
				subject.cid,
			),
			env.DB.prepare("UPDATE current_subjects SET deleted_at = ? WHERE uri = ?").bind(
				"2026-08-24T10:01:00.000Z",
				subject.uri,
			),
		]);
		const workflow = createWorkflowHarness();

		const report = await reconcileLabeler(
			dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
		);

		expect(report.repairCandidates).toEqual([]);
		expect(report.ensuredRunKeys).toEqual([]);
		expect(report.staleRuns).toEqual([]);
		expect(workflow.batches).toEqual([]);
	});

	it("reports a terminal assessment whose signed outcome label is absent", async () => {
		const subject = subjectFixture(3);
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const params = await createAssessmentWorkflowParams({
			subject,
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:missing-label",
		});
		await lifecycle.observeRun({ params, observedAt: "2026-08-24T09:00:00.000Z" });
		const running = await lifecycle.startRun(params.runKey, 0, "2026-08-24T09:01:00.000Z");
		const prepared = await lifecycle.persistPrepared(
			params.runKey,
			running.stateVersion,
			{
				moderationFingerprint: "sha256:missing-label",
				canonicalInput: {},
				coverage: {},
			},
			"2026-08-24T09:02:00.000Z",
		);
		await lifecycle.finalizeRun(
			params.runKey,
			prepared.stateVersion,
			"passed",
			"2026-08-24T09:03:00.000Z",
		);
		const workflow = createWorkflowHarness();

		const report = await reconcileLabeler(
			dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
		);

		expect(report.repairCandidates).toEqual([]);
		expect(report.missingOutcomeLabels).toEqual([
			{
				assessmentId: params.runKey,
				runKey: params.runKey,
				subject,
				outcome: "passed",
				expectedLabel: "listing-passed",
				policyVersion: ASSESSMENT_VERSIONS.policyVersion,
				completedAt: "2026-08-24T09:03:00.000Z",
			},
		]);
		expect(workflow.batches).toEqual([]);
	});

	it("bounds repair dispatches and every reported issue category", async () => {
		for (let index = 10; index < 14; index += 1) {
			await seedCurrentSubject(subjectFixture(index), `2026-08-24T10:00:0${index - 10}.000Z`);
		}
		const workflow = createWorkflowHarness();

		const report = await reconcileLabeler({
			...dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
			batchSize: 2,
		});

		expect(report.repairCandidates).toHaveLength(2);
		expect(report.ensuredRunKeys).toHaveLength(2);
		expect(workflow.batches).toHaveLength(1);
		expect(workflow.batches[0]).toHaveLength(2);
		for (const values of [
			report.repairCandidates,
			report.missingOutcomeLabels,
			report.staleRuns,
			report.quarantinedItems,
		]) {
			expect(values.length).toBeLessThanOrEqual(2);
		}
	});

	it("reports stale pending and running runs without starting replacements", async () => {
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const pendingParams = await createAssessmentWorkflowParams({
			subject: subjectFixture(20),
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:stale-pending",
		});
		await lifecycle.observeRun({
			params: pendingParams,
			observedAt: "2026-08-24T08:00:00.000Z",
		});
		const runningParams = await createAssessmentWorkflowParams({
			subject: subjectFixture(21),
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:stale-running",
		});
		await lifecycle.observeRun({
			params: runningParams,
			observedAt: "2026-08-24T08:01:00.000Z",
		});
		await lifecycle.startRun(runningParams.runKey, 0, "2026-08-24T08:02:00.000Z");
		const workflow = createWorkflowHarness();

		const report = await reconcileLabeler({
			...dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
			staleAfterMs: 60 * 60 * 1_000,
		});

		expect(report.staleRuns).toEqual([
			expect.objectContaining({ runKey: pendingParams.runKey, state: "pending" }),
			expect.objectContaining({ runKey: runningParams.runKey, state: "running" }),
		]);
		expect(report.repairCandidates).toEqual([]);
		expect(workflow.batches).toEqual([]);
		await expect(
			repairLabelerReconciliationFindings({
				db: env.DB,
				report,
				lifecycle,
				workflow: workflow.binding,
				workflowPresence: workflow.presence,
				restartWorkflow: workflow.restart,
				queue: { send: async () => undefined },
				authoritative: {
					listCurrentSubjects: async () => ({ items: [] }),
					isCurrentSubject: async () => true,
				},
				versions: ASSESSMENT_VERSIONS,
				now: () => new Date("2026-08-24T10:05:01.000Z"),
			}),
		).resolves.toMatchObject({ staleRuns: 2 });
		expect(workflow.batches).toHaveLength(1);
		expect(workflow.batches[0]).toHaveLength(2);
	});

	it("authoritatively cancels a quarantined delete hint", async () => {
		const subject = subjectFixture(30);
		await seedCurrentSubject(subject, "2026-08-24T08:00:00.000Z");
		await env.DB.prepare(
			`INSERT INTO discovery_quarantine
			   (cursor, reason, event_summary, requires_reconciliation, observed_at)
			 VALUES ('700', 'delete-requires-authoritative-reconciliation', ?, 1, ?)`,
		)
			.bind(JSON.stringify({ operation: "delete", uri: subject.uri }), "2026-08-24T08:01:00.000Z")
			.run();
		const lifecycle = createD1AssessmentLifecycleStore(env.DB);
		const workflow = createWorkflowHarness();
		const report = await reconcileLabeler(
			dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
		);
		await repairLabelerReconciliationFindings({
			db: env.DB,
			report,
			lifecycle,
			workflow: workflow.binding,
			workflowPresence: workflow.presence,
			restartWorkflow: workflow.restart,
			queue: { send: async () => undefined },
			authoritative: {
				listCurrentSubjects: async () => ({ items: [] }),
				isCurrentSubject: async () => false,
			},
			versions: ASSESSMENT_VERSIONS,
		});
		expect(
			await env.DB.prepare("SELECT deleted_at FROM current_subjects WHERE uri = ?")
				.bind(subject.uri)
				.first<string>("deleted_at"),
		).not.toBeNull();
		expect(
			await env.DB.prepare(
				"SELECT requires_reconciliation FROM discovery_quarantine_events WHERE quarantine_id = 'legacy:700'",
			).first<number>("requires_reconciliation"),
		).toBe(0);
	});

	it("reports discovery quarantine entries without interpreting their payload", async () => {
		await env.DB.prepare(
			`INSERT INTO discovery_quarantine
			   (cursor, reason, event_summary, requires_reconciliation, observed_at)
			 VALUES (?, ?, ?, 1, ?)`,
		)
			.bind(
				"500",
				"malformed relevant event",
				'{"commit":{"operation":"create"}}',
				"2026-08-24T08:00:00.000Z",
			)
			.run();
		const workflow = createWorkflowHarness();

		const report = await reconcileLabeler(
			dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
		);

		expect(report.quarantinedItems).toEqual([
			{
				quarantineId: "legacy:500",
				cursor: "500",
				reason: "malformed relevant event",
				eventSummary: '{"commit":{"operation":"create"}}',
				observedAt: "2026-08-24T08:00:00.000Z",
				revision: 1,
			},
		]);
	});

	it("keeps a delete quarantine armed while the aggregator still reports the subject current", async () => {
		const subject = subjectFixture(31);
		await seedCurrentSubject(subject, "2026-08-24T08:00:00.000Z");
		await env.DB.prepare(
			`INSERT INTO discovery_quarantine
			   (cursor, reason, event_summary, requires_reconciliation, observed_at)
			 VALUES ('701', 'delete-requires-authoritative-reconciliation', ?, 1, ?)`,
		)
			.bind(JSON.stringify({ operation: "delete", uri: subject.uri }), "2026-08-24T08:01:00.000Z")
			.run();
		const workflow = createWorkflowHarness();
		const report = await reconcileLabeler(
			dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
		);
		const repair = await repairLabelerReconciliationFindings({
			db: env.DB,
			report,
			lifecycle: createD1AssessmentLifecycleStore(env.DB),
			workflow: workflow.binding,
			workflowPresence: workflow.presence,
			restartWorkflow: workflow.restart,
			queue: { send: async () => undefined },
			authoritative: {
				listCurrentSubjects: async () => ({ items: [] }),
				isCurrentSubject: async () => true,
			},
			versions: ASSESSMENT_VERSIONS,
		});

		expect(repair.quarantineItems).toBe(0);
		expect(
			await env.DB.prepare(
				"SELECT requires_reconciliation FROM discovery_quarantine_events WHERE quarantine_id = 'legacy:701'",
			).first<number>("requires_reconciliation"),
		).toBe(1);
		expect(
			await env.DB.prepare("SELECT deleted_at FROM current_subjects WHERE uri = ?")
				.bind(subject.uri)
				.first<string | null>("deleted_at"),
		).toBeNull();
	});

	it("does not resolve a quarantine row re-armed while its event is requeued", async () => {
		await env.DB.prepare(
			`INSERT INTO discovery_quarantine_events
			   (quarantine_id, cursor, event_id, order_key, reason, event_summary,
			    requires_reconciliation, event_json, observed_at, revision)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
		)
			.bind(
				"event:800:10:event-race:order-race",
				"800",
				"event-race",
				"order-race",
				"queue-retries-exhausted",
				JSON.stringify({ kind: "queue-retries-exhausted" }),
				JSON.stringify({ kind: "identity", did: PUBLISHER_DID }),
				"2026-08-24T08:00:00.000Z",
			)
			.run();
		const workflow = createWorkflowHarness();
		const report = await reconcileLabeler(
			dependenciesFor(workflow, new Date("2026-08-24T10:05:00.000Z")),
		);

		const repair = await repairLabelerReconciliationFindings({
			db: env.DB,
			report,
			lifecycle: createD1AssessmentLifecycleStore(env.DB),
			workflow: workflow.binding,
			workflowPresence: workflow.presence,
			restartWorkflow: workflow.restart,
			queue: {
				async send(message) {
					await quarantineDiscoveryDeadLetters(deadLetterBatch(message), env);
				},
			},
			authoritative: {
				listCurrentSubjects: async () => ({ items: [] }),
				isCurrentSubject: async () => true,
			},
			versions: ASSESSMENT_VERSIONS,
			now: () => new Date("2026-08-24T10:05:02.000Z"),
		});

		expect(repair.quarantineItems).toBe(0);
		expect(
			await env.DB.prepare(
				`SELECT requires_reconciliation, revision
				 FROM discovery_quarantine_events
				 WHERE quarantine_id = ?`,
			)
				.bind("event:800:10:event-race:order-race")
				.first<{ requires_reconciliation: number; revision: number }>(),
		).toEqual({ requires_reconciliation: 1, revision: 2 });
	});
});

function dependenciesFor(workflow: ReturnType<typeof createWorkflowHarness>, now: Date) {
	return {
		store: createD1LabelerReconciliationStore(env.DB),
		lifecycle: createD1AssessmentLifecycleStore(env.DB),
		workflow: workflow.binding,
		workflowPresence: workflow.presence,
		restartWorkflow: workflow.restart,
		versions: ASSESSMENT_VERSIONS,
		expectedLabelSource: LABELER_DID,
		now: () => now,
	};
}

function deadLetterBatch(body: unknown): MessageBatch {
	return {
		messages: [
			{
				id: "repair-race",
				timestamp: new Date("2026-08-24T10:05:01.000Z"),
				body,
				attempts: 5,
				retry() {},
				ack() {},
			},
		],
		queue: "discovery-dead-letter",
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		retryAll() {},
		ackAll() {},
	};
}

function createWorkflowHarness(
	missingPresence: Extract<ReconciliationWorkflowPresence, "missing" | "restartable"> = "missing",
): {
	binding: AssessmentWorkflowBinding;
	presence(runKey: string): Promise<ReconciliationWorkflowPresence>;
	restart(runKey: string): Promise<void>;
	batches: Array<Array<{ id: string; params: AssessmentWorkflowParams }>>;
	restarts: string[];
} {
	const existing = new Set<string>();
	const batches: Array<Array<{ id: string; params: AssessmentWorkflowParams }>> = [];
	const restarts: string[] = [];
	return {
		binding: {
			async createBatch(batch) {
				if (batch.some(({ id }) => existing.has(id))) {
					throw new Error("Workflow instance already exists");
				}
				batches.push(batch);
				for (const { id } of batch) existing.add(id);
				return batch.map(() => ({}));
			},
		},
		async presence(runKey) {
			return existing.has(runKey) ? "existing" : missingPresence;
		},
		async restart(runKey) {
			restarts.push(runKey);
			existing.add(runKey);
		},
		batches,
		restarts,
	};
}

async function seedCurrentSubject(subject: AssessmentSubject, observedAt: string): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO subjects
				   (uri, cid, kind, publisher_did, first_observed_at, last_observed_at, deleted_at)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		).bind(subject.uri, subject.cid, subject.kind, PUBLISHER_DID, observedAt, observedAt),
		env.DB.prepare(
			`INSERT INTO current_subjects (uri, cid, kind, updated_at, deleted_at)
				 VALUES (?, ?, ?, ?, NULL)`,
		).bind(subject.uri, subject.cid, subject.kind, observedAt),
	]);
}

function subjectFixture(index: number): AssessmentSubject {
	const suffix = index.toString(36).padStart(4, "0");
	return {
		uri: `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.profile/reconcile-${suffix}`,
		cid: `${PROFILE_CID.slice(0, -4)}${suffix}`,
		kind: "profile",
	};
}
