import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { computeRunKey, initialTriggerId } from "../src/assessment-lifecycle.js";
import {
	createAssessmentRun,
	createSubject,
	transitionAssessmentState,
} from "../src/assessment-store.js";
import { reconcileAssessments, sweepPendingPublications } from "../src/reconciliation.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
let releaseCounter = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

function release(): { uri: string; cid: string } {
	releaseCounter++;
	return {
		uri: `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/recon-${releaseCounter}:1.0.0`,
		cid: `bafkreirecon${releaseCounter}000000000000000000000000000000000000000`,
	};
}

async function subject(now?: Date): Promise<{ uri: string; cid: string }> {
	const target = release();
	await createSubject(testEnv.DB, {
		uri: target.uri,
		cid: target.cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: target.uri.split("/").at(-1)!,
		...(now ? { now } : {}),
	});
	return target;
}

async function runAt(target: { uri: string; cid: string }, now: Date): Promise<string> {
	const runKey = await computeRunKey({
		uri: target.uri,
		cid: target.cid,
		policyVersion: "v1",
		modelId: "m",
		promptHash: "p",
		scannerSetVersion: "v1",
		triggerId: initialTriggerId(target.cid),
	});
	const { assessment } = await createAssessmentRun(testEnv.DB, {
		runKey,
		uri: target.uri,
		cid: target.cid,
		trigger: "initial",
		triggerId: initialTriggerId(target.cid),
		policyVersion: "v1",
		coverageJson: "{}",
		now,
	});
	return assessment.id;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("reconcileAssessments", () => {
	it("flags a run stuck in pending past the staleness threshold", async () => {
		const target = await subject();
		const staleCreatedAt = new Date(Date.now() - 2 * ONE_HOUR_MS);
		const id = await runAt(target, staleCreatedAt);
		await transitionAssessmentState(testEnv.DB, { id, from: "observed", to: "verifying" });
		await transitionAssessmentState(testEnv.DB, { id, from: "verifying", to: "pending" });

		const report = await reconcileAssessments(testEnv.DB, new Date());

		expect(report.stuckRuns.some((run) => run.id === id)).toBe(true);
	});

	it("does not flag a healthy (recent) pending run", async () => {
		const target = await subject();
		const id = await runAt(target, new Date());
		await transitionAssessmentState(testEnv.DB, { id, from: "observed", to: "verifying" });
		await transitionAssessmentState(testEnv.DB, { id, from: "verifying", to: "pending" });

		const report = await reconcileAssessments(testEnv.DB, new Date());

		expect(report.stuckRuns.some((run) => run.id === id)).toBe(false);
	});

	it("does not flag a terminal (passed/cancelled) run even if old", async () => {
		const target = await subject();
		const staleCreatedAt = new Date(Date.now() - 2 * ONE_HOUR_MS);
		const id = await runAt(target, staleCreatedAt);
		await transitionAssessmentState(testEnv.DB, { id, from: "observed", to: "verifying" });
		await transitionAssessmentState(testEnv.DB, { id, from: "verifying", to: "cancelled" });

		const report = await reconcileAssessments(testEnv.DB, new Date());

		expect(report.stuckRuns.some((run) => run.id === id)).toBe(false);
	});

	it("flags a verified subject with no assessment run at all", async () => {
		const target = await subject();

		const report = await reconcileAssessments(testEnv.DB, new Date());

		expect(
			report.subjectsWithoutRuns.some((s) => s.uri === target.uri && s.cid === target.cid),
		).toBe(true);
	});

	it("does not flag a subject once a run exists for it", async () => {
		const target = await subject();
		await runAt(target, new Date());

		const report = await reconcileAssessments(testEnv.DB, new Date());

		expect(
			report.subjectsWithoutRuns.some((s) => s.uri === target.uri && s.cid === target.cid),
		).toBe(false);
	});

	it("respects a custom staleness threshold", async () => {
		const target = await subject();
		const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
		const id = await runAt(target, fifteenMinutesAgo);
		await transitionAssessmentState(testEnv.DB, { id, from: "observed", to: "verifying" });

		const withDefaultThreshold = await reconcileAssessments(testEnv.DB, new Date());
		expect(withDefaultThreshold.stuckRuns.some((run) => run.id === id)).toBe(false);

		const withTightThreshold = await reconcileAssessments(testEnv.DB, new Date(), 5 * 60 * 1000);
		expect(withTightThreshold.stuckRuns.some((run) => run.id === id)).toBe(true);
	});
});

let seedCounter = 0;

/** Inserts a signed-label row directly with a chosen `cts` and pending flag,
 * returning its trigger-assigned sequence. */
async function seedPendingLabel(opts: {
	cts: string;
	publicationPending: boolean;
}): Promise<number> {
	seedCounter++;
	const idempotencyKey = `sweep-seed-${seedCounter}`;
	await testEnv.DB.prepare(
		`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, created_at)
		 VALUES (?, 'manual-label', 'sweep seed', ?, ?)`,
	)
		.bind("did:example:seed", idempotencyKey, opts.cts)
		.run();
	await testEnv.DB.prepare(
		`INSERT INTO issued_labels
		 (action_id, ver, src, uri, cid, val, neg, cts, exp, sig, signing_key_id,
		  signing_key_version, publication_pending)
		 SELECT id, 1, 'did:example:seed', ?, NULL, 'security-yanked', 0, ?, NULL, ?,
		  'did:example:seed#atproto_label', 'v1', ?
		 FROM issuance_actions WHERE idempotency_key = ?`,
	)
		.bind(
			`at://did:example:seed/com.emdashcms.experimental.package.release/sweep-${seedCounter}:1.0.0`,
			opts.cts,
			new Uint8Array([1, 2, 3]),
			opts.publicationPending ? 1 : 0,
			idempotencyKey,
		)
		.run();
	const row = await testEnv.DB.prepare(
		`SELECT sequence FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
		 WHERE a.idempotency_key = ?`,
	)
		.bind(idempotencyKey)
		.first<{ sequence: number }>();
	return row!.sequence;
}

describe("sweepPendingPublications", () => {
	const now = new Date("2026-07-18T12:00:00.000Z");
	const oldCts = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
	const recentCts = new Date(now.getTime() - 60 * 1000).toISOString();

	it("re-drives only pending rows older than the threshold", async () => {
		const stale = await seedPendingLabel({ cts: oldCts, publicationPending: true });
		const recent = await seedPendingLabel({ cts: recentCts, publicationPending: true });
		const settled = await seedPendingLabel({ cts: oldCts, publicationPending: false });

		const notified: number[] = [];
		const report = await sweepPendingPublications({
			db: testEnv.DB,
			notify: async (sequence) => {
				notified.push(sequence);
			},
			now,
		});

		expect(notified).toContain(stale);
		expect(notified).not.toContain(recent);
		expect(notified).not.toContain(settled);
		expect(report.redriven).toBeGreaterThanOrEqual(1);
		expect(report.failed).toBe(0);
	});

	it("counts a failed notify without throwing, leaving the row for a later pass", async () => {
		const stuck = await seedPendingLabel({ cts: oldCts, publicationPending: true });

		const report = await sweepPendingPublications({
			db: testEnv.DB,
			notify: (sequence) =>
				sequence === stuck ? Promise.reject(new Error("DO unreachable")) : Promise.resolve(),
			now,
		});

		expect(report.failed).toBeGreaterThanOrEqual(1);
		// The row is untouched (still pending) — the sweep never clears the flag
		// itself; only a successful DO notify does.
		const stillPending = await testEnv.DB.prepare(
			`SELECT publication_pending FROM issued_labels WHERE sequence = ?`,
		)
			.bind(stuck)
			.first<{ publication_pending: number }>();
		expect(stillPending?.publication_pending).toBe(1);
	});
});
