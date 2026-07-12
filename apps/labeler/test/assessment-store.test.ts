import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	AssessmentTransitionConflictError,
	automatedIdempotencyKey,
	computeRunKey,
	initialTriggerId,
	operatorTriggerId,
} from "../src/assessment-lifecycle.js";
import {
	buildFinalizationStatements,
	createAssessmentRun,
	createSubject,
	deleteSubject,
	getAssessment,
	getCurrentAssessment,
	isSubjectCurrent,
	recordEvidenceObject,
	recordFinding,
	transitionAssessmentState,
} from "../src/assessment-store.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const LABELER_DID = "did:web:labels.emdashcms.com";
let releaseCounter = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

function release(): { uri: string; cid: string } {
	releaseCounter++;
	return {
		uri: `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/store-${releaseCounter}:1.0.0`,
		cid: `bafkreicid${releaseCounter}00000000000000000000000000000000000000000`,
	};
}

async function observedSubject(): Promise<{ uri: string; cid: string }> {
	const subject = release();
	await createSubject(testEnv.DB, {
		uri: subject.uri,
		cid: subject.cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: subject.uri.split("/").at(-1)!,
	});
	return subject;
}

async function runningAssessment(
	subject?: { uri: string; cid: string },
	triggerId?: string,
): Promise<{
	subject: { uri: string; cid: string };
	assessment: Awaited<ReturnType<typeof transitionAssessmentState>>;
}> {
	const target = subject ?? (await observedSubject());
	const trigger = triggerId ?? initialTriggerId(target.cid);
	const runKey = await computeRunKey({
		uri: target.uri,
		cid: target.cid,
		policyVersion: "2026-07-10.experimental.2",
		modelId: "test-model",
		promptHash: "test-prompt-hash",
		scannerSetVersion: "v1",
		triggerId: trigger,
	});
	const { assessment } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri: target.uri,
		cid: target.cid,
		trigger: trigger.startsWith("operator:") ? "operator" : "initial",
		triggerId: trigger,
		policyVersion: "2026-07-10.experimental.2",
		scannerVersionsJson: "[]",
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
	const running = await transitionAssessmentState(testEnv.DB, {
		id: assessment.id,
		from: "pending",
		to: "running",
	});
	return { subject: target, assessment: running };
}

describe("migration schema", () => {
	it("creates the assessment-lifecycle tables with their indexes", async () => {
		const rows = await testEnv.DB.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
			 'subjects', 'assessments', 'current_assessments', 'findings',
			 'evidence_objects', 'dead_letters', 'ingest_state'
			 ) ORDER BY name`,
		).all<{ name: string }>();
		expect((rows.results ?? []).map((row) => row.name)).toEqual([
			"assessments",
			"current_assessments",
			"dead_letters",
			"evidence_objects",
			"findings",
			"ingest_state",
			"subjects",
		]);
		const indexes = await testEnv.DB.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%assessment%'
			 ORDER BY name`,
		).all<{ name: string }>();
		expect((indexes.results ?? []).map((row) => row.name)).toEqual(
			expect.arrayContaining([
				"idx_assessments_state_created",
				"idx_assessments_subject",
				"idx_assessments_supersedes",
				"idx_current_assessments_assessment",
			]),
		);
	});

	it("rejects a state outside the lifecycle vocabulary", async () => {
		const subject = await observedSubject();
		await expect(
			testEnv.DB.prepare(
				`INSERT INTO assessments
				 (id, run_key, uri, cid, state, trigger, trigger_id, policy_version,
				  scanner_versions_json, coverage_json, created_at, created_at_epoch_ms)
				 VALUES ('asmt_00000000000000000000000000', 'garbage-run-key', ?, ?, 'not-a-state',
				 'initial', 'initial:x', 'v1', '[]', '{}', '2026-01-01T00:00:00.000Z', 0)`,
			)
				.bind(subject.uri, subject.cid)
				.run(),
		).rejects.toThrow();
	});
});

describe("subjects", () => {
	it("reactivates a tombstoned subject on a verified re-observation", async () => {
		const subject = release();
		const seed = {
			uri: subject.uri,
			cid: subject.cid,
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: subject.uri.split("/").at(-1)!,
		};
		await createSubject(testEnv.DB, seed);
		await deleteSubject(testEnv.DB, { uri: subject.uri, cid: subject.cid });
		expect(await isSubjectCurrent(testEnv.DB, subject)).toBe(false);

		// A verified re-observation (create path only reaches here after PDS
		// verification) clears the tombstone.
		await createSubject(testEnv.DB, seed);
		expect(await isSubjectCurrent(testEnv.DB, subject)).toBe(true);
	});

	it("treats exactly one same-instant sibling as current (deterministic tie-break)", async () => {
		const uri = release().uri;
		const now = new Date("2026-07-11T00:00:00.000Z");
		const base = {
			uri,
			did: PUBLISHER_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: uri.split("/").at(-1)!,
			now,
		};
		const cidLow = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const cidHigh = "bafyreizzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
		await createSubject(testEnv.DB, { ...base, cid: cidLow });
		await createSubject(testEnv.DB, { ...base, cid: cidHigh });

		// Same observed_at_epoch_ms: the greater CID wins, so exactly one is current.
		expect(await isSubjectCurrent(testEnv.DB, { uri, cid: cidHigh })).toBe(true);
		expect(await isSubjectCurrent(testEnv.DB, { uri, cid: cidLow })).toBe(false);
	});
});

describe("assessment lifecycle", () => {
	it("creates a run in the observed state and walks every legal transition", async () => {
		const subject = await observedSubject();
		const runKey = await computeRunKey({
			uri: subject.uri,
			cid: subject.cid,
			policyVersion: "2026-07-10.experimental.2",
			modelId: "test-model",
			promptHash: "test-prompt-hash",
			scannerSetVersion: "v1",
			triggerId: initialTriggerId(subject.cid),
		});
		const { assessment, created } = await createAssessmentRun(testEnv.DB, {
			runKey,
			uri: subject.uri,
			cid: subject.cid,
			trigger: "initial",
			triggerId: initialTriggerId(subject.cid),
			policyVersion: "2026-07-10.experimental.2",
			scannerVersionsJson: "[]",
			coverageJson: "{}",
		});
		expect(created).toBe(true);
		expect(assessment.state).toBe("observed");
		expect(assessment.id).toMatch(/^asmt_[0-9A-HJKMNP-TV-Z]{26}$/);

		const verifying = await transitionAssessmentState(testEnv.DB, {
			id: assessment.id,
			from: "observed",
			to: "verifying",
		});
		expect(verifying.state).toBe("verifying");
		const pending = await transitionAssessmentState(testEnv.DB, {
			id: assessment.id,
			from: "verifying",
			to: "pending",
		});
		expect(pending.state).toBe("pending");
		expect(pending.startedAt).toBeNull();
		const running = await transitionAssessmentState(testEnv.DB, {
			id: assessment.id,
			from: "pending",
			to: "running",
		});
		expect(running.state).toBe("running");
		expect(running.startedAt).not.toBeNull();
	});

	it("rejects every illegal transition instead of no-op'ing", async () => {
		const { assessment } = await runningAssessment();
		await expect(
			transitionAssessmentState(testEnv.DB, { id: assessment.id, from: "observed", to: "pending" }),
		).rejects.toThrow("illegal assessment transition");
		await expect(
			transitionAssessmentState(testEnv.DB, {
				id: assessment.id,
				from: "running",
				to: "verifying",
			}),
		).rejects.toThrow("illegal assessment transition");
		await expect(
			transitionAssessmentState(testEnv.DB, { id: assessment.id, from: "passed", to: "running" }),
		).rejects.toThrow("illegal assessment transition");
	});

	it("requires buildFinalizationStatements for decision outcomes", async () => {
		const { assessment } = await runningAssessment();
		await expect(
			transitionAssessmentState(testEnv.DB, { id: assessment.id, from: "running", to: "passed" }),
		).rejects.toThrow("use buildFinalizationStatements");
		expect(() =>
			buildFinalizationStatements(testEnv.DB, {
				assessmentId: assessment.id,
				fromState: "pending",
				toState: "passed",
				src: LABELER_DID,
				uri: assessment.uri,
				cid: assessment.cid,
			}),
		).toThrow("illegal assessment transition");
		expect(() =>
			buildFinalizationStatements(testEnv.DB, {
				assessmentId: assessment.id,
				fromState: "running",
				toState: "stale",
				src: LABELER_DID,
				uri: assessment.uri,
				cid: assessment.cid,
			}),
		).toThrow("buildFinalizationStatements is for decision outcomes");
	});

	it("allows stale and cancelled directly from any non-terminal state", async () => {
		const observed = await observedSubject();
		const runKey = await computeRunKey({
			uri: observed.uri,
			cid: observed.cid,
			policyVersion: "v1",
			modelId: "m",
			promptHash: "p",
			scannerSetVersion: "v1",
			triggerId: initialTriggerId(observed.cid),
		});
		const { assessment } = await createAssessmentRun(testEnv.DB, {
			runKey,
			uri: observed.uri,
			cid: observed.cid,
			trigger: "initial",
			triggerId: initialTriggerId(observed.cid),
			policyVersion: "v1",
			scannerVersionsJson: "[]",
			coverageJson: "{}",
		});
		const cancelled = await transitionAssessmentState(testEnv.DB, {
			id: assessment.id,
			from: "observed",
			to: "cancelled",
		});
		expect(cancelled.state).toBe("cancelled");

		const { assessment: running } = await runningAssessment();
		const stale = await transitionAssessmentState(testEnv.DB, {
			id: running.id,
			from: "running",
			to: "stale",
		});
		expect(stale.state).toBe("stale");
	});

	it("returns the existing run for a redelivered run key instead of creating a second one", async () => {
		const subject = await observedSubject();
		const input = {
			uri: subject.uri,
			cid: subject.cid,
			trigger: "initial",
			triggerId: initialTriggerId(subject.cid),
			policyVersion: "v1",
			scannerVersionsJson: "[]",
			coverageJson: "{}",
		};
		const runKey = await computeRunKey({
			uri: subject.uri,
			cid: subject.cid,
			policyVersion: "v1",
			modelId: "m",
			promptHash: "p",
			scannerSetVersion: "v1",
			triggerId: initialTriggerId(subject.cid),
		});
		const first = await createAssessmentRun(testEnv.DB, { ...input, runKey });
		const second = await createAssessmentRun(testEnv.DB, { ...input, runKey });
		expect(second.created).toBe(false);
		expect(second.assessment.id).toBe(first.assessment.id);
	});

	it("resolves a concurrent CAS race with exactly one winner", async () => {
		const { assessment } = await runningAssessment();
		const outcomes = await Promise.allSettled([
			transitionAssessmentState(testEnv.DB, { id: assessment.id, from: "running", to: "stale" }),
			transitionAssessmentState(testEnv.DB, {
				id: assessment.id,
				from: "running",
				to: "cancelled",
			}),
		]);
		const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			AssessmentTransitionConflictError,
		);
	});
});

describe("finalization", () => {
	it("completes a run and moves the current-assessment pointer in one batch", async () => {
		const { subject, assessment } = await runningAssessment();
		const { statements, assessmentUpdateIndex, pointerUpdateIndex } = buildFinalizationStatements(
			testEnv.DB,
			{
				assessmentId: assessment.id,
				fromState: "running",
				toState: "passed",
				src: LABELER_DID,
				uri: subject.uri,
				cid: subject.cid,
				publicSummary: "no blocking condition found",
			},
		);
		expect(pointerUpdateIndex).not.toBeNull();
		const results = await testEnv.DB.batch(statements);
		expect(results[assessmentUpdateIndex]?.meta.changes).toBe(1);
		const completed = await getAssessment(testEnv.DB, assessment.id);
		expect(completed?.state).toBe("passed");
		expect(completed?.completedAt).not.toBeNull();
		expect(completed?.publicSummary).toBe("no blocking condition found");
		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer?.assessmentId).toBe(assessment.id);
	});

	it("never moves the pointer for an assessment-error outcome", async () => {
		const { subject, assessment } = await runningAssessment();
		const { statements } = buildFinalizationStatements(testEnv.DB, {
			assessmentId: assessment.id,
			fromState: "running",
			toState: "error",
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		await testEnv.DB.batch(statements);
		const completed = await getAssessment(testEnv.DB, assessment.id);
		expect(completed?.state).toBe("error");
		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer).toBeNull();
	});

	it("leaves zero rows from the batch when a later statement fails (atomicity)", async () => {
		const { subject, assessment } = await runningAssessment();
		const { statements } = buildFinalizationStatements(testEnv.DB, {
			assessmentId: assessment.id,
			fromState: "running",
			toState: "passed",
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		// A runtime constraint violation (duplicate subject PK), not a missing
		// table: this proves the batch begins, applies the earlier statements,
		// then rolls them back — a build-time failure would prove nothing about
		// prior-statement rollback.
		const failing = testEnv.DB.prepare(
			`INSERT INTO subjects (uri, cid, did, collection, rkey, observed_at, observed_at_epoch_ms)
			 VALUES (?, ?, 'did:web:x', 'c', 'r', ?, ?)`,
		).bind(subject.uri, subject.cid, new Date().toISOString(), Date.now());
		await expect(testEnv.DB.batch([...statements, failing])).rejects.toThrow();
		const untouched = await getAssessment(testEnv.DB, assessment.id);
		expect(untouched?.state).toBe("running");
		expect(untouched?.completedAt).toBeNull();
		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer).toBeNull();
	});

	it("a CAS conflict at finalization leaves the pointer statement inert even without a batch error", async () => {
		const { subject, assessment } = await runningAssessment();
		// Race the finalization out from under the statements before they run:
		// the CAS UPDATE affects zero rows, so the guarded pointer INSERT must
		// also affect zero rows in the same batch, not blindly write the pointer.
		await transitionAssessmentState(testEnv.DB, {
			id: assessment.id,
			from: "running",
			to: "stale",
		});
		const { statements, assessmentUpdateIndex, pointerUpdateIndex } = buildFinalizationStatements(
			testEnv.DB,
			{
				assessmentId: assessment.id,
				fromState: "running",
				toState: "passed",
				src: LABELER_DID,
				uri: subject.uri,
				cid: subject.cid,
			},
		);
		const results = await testEnv.DB.batch(statements);
		expect(results[assessmentUpdateIndex]?.meta.changes).toBe(0);
		expect(results[pointerUpdateIndex!]?.meta.changes).toBe(0);
		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer).toBeNull();
	});
});

describe("supersession", () => {
	it("a newer completed run replaces the pointer and links supersedes_assessment_id", async () => {
		const subject = await observedSubject();
		const first = await runningAssessment(subject);
		const firstFinalization = buildFinalizationStatements(testEnv.DB, {
			assessmentId: first.assessment.id,
			fromState: "running",
			toState: "passed",
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		await testEnv.DB.batch(firstFinalization.statements);

		const second = await runningAssessment(subject, operatorTriggerId("operator-rerun-1"));
		const secondFinalization = buildFinalizationStatements(testEnv.DB, {
			assessmentId: second.assessment.id,
			fromState: "running",
			toState: "blocked",
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
			supersedesAssessmentId: first.assessment.id,
		});
		await testEnv.DB.batch(secondFinalization.statements);

		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer?.assessmentId).toBe(second.assessment.id);
		const completedSecond = await getAssessment(testEnv.DB, second.assessment.id);
		expect(completedSecond?.supersedesAssessmentId).toBe(first.assessment.id);
		const completedFirst = await getAssessment(testEnv.DB, first.assessment.id);
		expect(completedFirst?.state).toBe("passed");
	});

	it("does not regress the pointer when an older run finalizes after a newer one", async () => {
		const subject = await observedSubject();

		async function runningRun(triggerSuffix: string, createdAt: Date) {
			const triggerId = operatorTriggerId(triggerSuffix);
			const runKey = await computeRunKey({
				uri: subject.uri,
				cid: subject.cid,
				policyVersion: "v1",
				modelId: "m",
				promptHash: "p",
				scannerSetVersion: "v1",
				triggerId,
			});
			const { assessment } = await createAssessmentRun(testEnv.DB, {
				runKey,
				uri: subject.uri,
				cid: subject.cid,
				trigger: "operator",
				triggerId,
				policyVersion: "v1",
				scannerVersionsJson: "[]",
				coverageJson: "{}",
				now: createdAt,
			});
			for (const [from, to] of [
				["observed", "verifying"],
				["verifying", "pending"],
				["pending", "running"],
			] as const) {
				await transitionAssessmentState(testEnv.DB, { id: assessment.id, from, to });
			}
			return assessment.id;
		}

		const olderId = await runningRun("older", new Date("2026-07-10T00:00:00.000Z"));
		const newerId = await runningRun("newer", new Date("2026-07-11T00:00:00.000Z"));

		const finalize = (id: string) =>
			buildFinalizationStatements(testEnv.DB, {
				assessmentId: id,
				fromState: "running",
				toState: "passed",
				src: LABELER_DID,
				uri: subject.uri,
				cid: subject.cid,
			}).statements;

		// Newer run wins the pointer, then the older run finalizes last.
		await testEnv.DB.batch(finalize(newerId));
		await testEnv.DB.batch(finalize(olderId));

		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer?.assessmentId).toBe(newerId);
	});

	it("a pending newer run never moves the current pointer", async () => {
		const subject = await observedSubject();
		const first = await runningAssessment(subject);
		await testEnv.DB.batch(
			buildFinalizationStatements(testEnv.DB, {
				assessmentId: first.assessment.id,
				fromState: "running",
				toState: "passed",
				src: LABELER_DID,
				uri: subject.uri,
				cid: subject.cid,
			}).statements,
		);

		const runKey = await computeRunKey({
			uri: subject.uri,
			cid: subject.cid,
			policyVersion: "v2",
			modelId: "m",
			promptHash: "p",
			scannerSetVersion: "v2",
			triggerId: operatorTriggerId("operator-action-1"),
		});
		await createAssessmentRun(testEnv.DB, {
			runKey,
			uri: subject.uri,
			cid: subject.cid,
			trigger: "operator",
			triggerId: operatorTriggerId("operator-action-1"),
			policyVersion: "v2",
			scannerVersionsJson: "[]",
			coverageJson: "{}",
		});

		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer?.assessmentId).toBe(first.assessment.id);
	});

	it("stale and cancelled runs never become current", async () => {
		const subject = await observedSubject();
		const run = await runningAssessment(subject);
		await transitionAssessmentState(testEnv.DB, {
			id: run.assessment.id,
			from: "running",
			to: "stale",
		});
		const pointer = await getCurrentAssessment(testEnv.DB, {
			src: LABELER_DID,
			uri: subject.uri,
			cid: subject.cid,
		});
		expect(pointer).toBeNull();
	});
});

describe("subjects, findings, and evidence", () => {
	it("marks a subject deleted without losing assessment history", async () => {
		const subject = await observedSubject();
		await deleteSubject(testEnv.DB, { uri: subject.uri, cid: subject.cid });
		const row = await testEnv.DB.prepare(
			"SELECT deleted_at FROM subjects WHERE uri = ? AND cid = ?",
		)
			.bind(subject.uri, subject.cid)
			.first<{ deleted_at: string | null }>();
		expect(row?.deleted_at).not.toBeNull();
	});

	it("records findings and evidence objects against an assessment", async () => {
		const { assessment } = await runningAssessment();
		const findingId = await recordFinding(testEnv.DB, {
			assessmentId: assessment.id,
			source: "deterministic",
			category: "malware",
			severity: "critical",
			title: "known malicious hash",
			publicSummary: "the bundle matched a known malicious hash",
			privateDetail: "sha256 match against denylist entry xyz",
			evidenceRefs: ["file:src/index.js"],
		});
		expect(findingId).toMatch(/^find_/);
		const evidenceId = await recordEvidenceObject(testEnv.DB, {
			assessmentId: assessment.id,
			kind: "scanner-report",
			sha256: "0".repeat(64),
			metadata: { scanner: "test-scanner" },
		});
		expect(evidenceId).toMatch(/^evid_/);
		const findingRow = await testEnv.DB.prepare("SELECT assessment_id FROM findings WHERE id = ?")
			.bind(findingId)
			.first<{ assessment_id: string }>();
		expect(findingRow?.assessment_id).toBe(assessment.id);
	});
});

describe("automated idempotency key", () => {
	it("is deterministic and distinguishes negation from assertion", async () => {
		const runKey = await computeRunKey({
			uri: "at://did:example:x/com.emdashcms.experimental.package.release/y:1.0.0",
			cid: "cid",
			policyVersion: "v1",
			modelId: "m",
			promptHash: "p",
			scannerSetVersion: "v1",
			triggerId: initialTriggerId("cid"),
		});
		const positive = automatedIdempotencyKey(runKey, "malware", false);
		const negative = automatedIdempotencyKey(runKey, "malware", true);
		expect(positive).not.toBe(negative);
		expect(automatedIdempotencyKey(runKey, "malware", false)).toBe(positive);
	});
});
