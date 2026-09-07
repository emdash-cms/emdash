import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { EvalRunFailedError, EvalRunInProgressError } from "../evals/production.js";
import type { OperatorIdentity } from "../src/access.js";
import type { AssessmentRunSnapshot } from "../src/assessment/types.js";
import {
	claimRerunIdempotency,
	handleOperatorApi,
	readOperatorAssessmentPage,
	type OperatorActionRecord,
	type OperatorApiDependencies,
	type OperatorRerunActionStore,
} from "../src/operator/api.js";

const RUN: AssessmentRunSnapshot = {
	runKey: "assessment-v1-fixture",
	subject: {
		uri: "at://did:plc:fixture/com.emdashcms.experimental.package.profile/demo",
		cid: "bafyfixturecid",
		kind: "profile",
	},
	state: "review",
	stateVersion: 3,
	deleted: false,
};

const REVIEWER: OperatorIdentity = {
	kind: "human",
	email: "reviewer@example.com",
	sub: "access-reviewer",
	roles: ["reviewer"],
};

const ADMIN: OperatorIdentity = {
	kind: "human",
	email: "admin@example.com",
	sub: "access-admin",
	roles: ["admin"],
};

describe("operator mutation API", () => {
	it("approves only the exact assessment CID through the typed issuer", async () => {
		const approve = vi.fn(async () => ({
			action: "approve" as const,
			operatorActionId: 7,
			labels: [],
		}));
		const response = await handleOperatorApi(
			operatorRequest(`/_admin/api/assessments/${RUN.runKey}/approve`, {
				reason: "Reviewed exact listing metadata",
				uri: RUN.subject.uri,
				cid: RUN.subject.cid,
			}),
			{} as Env,
			dependencies(REVIEWER, { approve }),
		);
		expect(response.status).toBe(200);
		expect(approve).toHaveBeenCalledWith(
			expect.objectContaining({
				actorDid: expect.stringMatching(/^did:web:labels\.emdashcms\.com:operators:/),
				role: "reviewer",
				reason: "Reviewed exact listing metadata",
				idempotencyKey: "operator-request-123",
			}),
			RUN.subject,
			expect.any(Date),
		);
	});

	it("requires the custom header, same origin, JSON, authentication, and role", async () => {
		const missingHeader = operatorRequest(`/_admin/api/assessments/${RUN.runKey}/approve`, {
			reason: "Review",
			uri: RUN.subject.uri,
			cid: RUN.subject.cid,
		});
		missingHeader.headers.delete("X-EmDash-Request");
		expect((await handleOperatorApi(missingHeader, {} as Env, dependencies(REVIEWER))).status).toBe(
			403,
		);

		const unauthenticated = dependencies(REVIEWER);
		unauthenticated.authenticate = async () => {
			throw new Error("authentication failed");
		};
		expect(
			(
				await handleOperatorApi(
					operatorRequest(`/_admin/api/assessments/${RUN.runKey}/approve`, {
						reason: "Review",
						uri: RUN.subject.uri,
						cid: RUN.subject.cid,
					}),
					{} as Env,
					unauthenticated,
				)
			).status,
		).toBe(401);

		const takedown = await handleOperatorApi(
			operatorRequest("/_admin/api/takedown", { reason: "Emergency", uri: RUN.subject.uri }),
			{} as Env,
			dependencies(REVIEWER),
		);
		expect(takedown.status).toBe(403);
	});

	it("binds a live evaluation to the admin, reason, and idempotency key", async () => {
		const runEvaluation = vi.fn(async () => ({
			runId: 41,
			instanceId: "listing-eval-41",
			status: "running" as const,
		}));
		const response = await handleOperatorApi(
			operatorRequest("/_admin/api/evals/run", {
				reason: "Compare the reviewed model bundle before promotion",
			}),
			{} as Env,
			{ ...dependencies(ADMIN), runEvaluation },
		);

		expect(response.status).toBe(202);
		expect(runEvaluation).toHaveBeenCalledWith({
			actorDid: "did:web:labels.emdashcms.com:operators:fixture",
			role: "admin",
			reason: "Compare the reviewed model bundle before promotion",
			idempotencyKey: "operator-request-123",
			now: new Date("2026-08-24T12:00:00.000Z"),
		});
		expect(await response.json()).toMatchObject({
			runId: 41,
			instanceId: "listing-eval-41",
			status: "running",
		});
	});

	it("returns stable running and failed live-evaluation responses", async () => {
		const running = await handleOperatorApi(
			operatorRequest("/_admin/api/evals/run", { reason: "Retry the protected evaluation" }),
			{} as Env,
			{
				...dependencies(ADMIN),
				runEvaluation: async () => {
					throw new EvalRunInProgressError(
						"Evaluation is already running for this idempotency key",
					);
				},
			},
		);
		expect(running.status).toBe(409);
		expect(await running.json()).toEqual({
			error: {
				code: "EVALUATION_RUNNING",
				message: "Evaluation is already running for this idempotency key",
			},
		});

		const failed = await handleOperatorApi(
			operatorRequest("/_admin/api/evals/run", { reason: "Retry the protected evaluation" }),
			{} as Env,
			{
				...dependencies(ADMIN),
				runEvaluation: async () => {
					throw new EvalRunFailedError(
						"EVALUATION_FAILED",
						"Protected live evaluation could not be completed",
					);
				},
			},
		);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({
			error: {
				code: "EVALUATION_FAILED",
				message: "Protected live evaluation could not be completed",
			},
		});
	});

	it("lets only admins query durable live-evaluation status", async () => {
		const readEvaluation = vi.fn(async () => ({
			runId: 41,
			instanceId: "listing-eval-41",
			status: "failed" as const,
			failure: { code: "EVALUATION_FAILED", summary: "Evaluation failed" },
		}));
		const adminResponse = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/evals/41"),
			{} as Env,
			{ ...dependencies(ADMIN), readEvaluation },
		);
		expect(adminResponse.status).toBe(200);
		expect(await adminResponse.json()).toMatchObject({ runId: 41, status: "failed" });
		expect(readEvaluation).toHaveBeenCalledWith(41);

		const reviewerResponse = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/evals/41"),
			{} as Env,
			{ ...dependencies(REVIEWER), readEvaluation },
		);
		expect(reviewerResponse.status).toBe(403);
	});
});

describe("operator review reads", () => {
	it("returns the current operator session without exposing Access configuration", async () => {
		const response = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/session"),
			{} as Env,
			dependencies(ADMIN),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			authenticated: true,
			identity: {
				kind: "human",
				principal: "admin@example.com",
				actorDid: "did:web:labels.emdashcms.com:operators:fixture",
				roles: ["admin"],
			},
		});
	});

	it("exposes issuance state to reviewers", async () => {
		const response = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/issuance"),
			{} as Env,
			{
				...dependencies(REVIEWER),
				readIssuance: async () => ({
					paused: true,
					updatedAt: "2026-08-24T12:00:00.000Z",
				}),
			},
		);
		expect(await response.json()).toEqual({
			paused: true,
			updatedAt: "2026-08-24T12:00:00.000Z",
		});
	});

	it("restricts evaluation and activity history to admins", async () => {
		const adminDependencies = {
			...dependencies(ADMIN),
			listEvaluations: vi.fn(async () => ({
				items: [{ id: 42, status: "succeeded" }],
				nextCursor: "41",
			})),
			listActivity: vi.fn(async () => ({
				items: [{ id: 9, action: "pause-issuance" }],
			})),
		};
		const evaluations = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/evals?limit=10&cursor=43"),
			{} as Env,
			adminDependencies,
		);
		expect(await evaluations.json()).toEqual({
			items: [{ id: 42, status: "succeeded" }],
			nextCursor: "41",
		});
		expect(adminDependencies.listEvaluations).toHaveBeenCalledWith(10, "43");

		const activity = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/activity"),
			{} as Env,
			adminDependencies,
		);
		expect(await activity.json()).toEqual({ items: [{ id: 9, action: "pause-issuance" }] });

		for (const path of ["/_admin/api/evals", "/_admin/api/activity"]) {
			const response = await handleOperatorApi(
				new Request(`https://labels.example${path}`),
				{} as Env,
				dependencies(REVIEWER),
			);
			expect(response.status).toBe(403);
		}
	});

	it("filters decided reviews before stable keyset pagination", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE assessments (
				run_key TEXT PRIMARY KEY,
				subject_uri TEXT NOT NULL,
				subject_cid TEXT NOT NULL,
				subject_kind TEXT NOT NULL,
				state TEXT NOT NULL,
				state_version INTEGER NOT NULL,
				policy_version TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT
			);
			CREATE TABLE operator_actions (
				id INTEGER PRIMARY KEY,
				action TEXT NOT NULL,
				subject_uri TEXT,
				subject_cid TEXT,
				created_at TEXT
			);
		`);
		const insertAssessment = db.prepare(
			`INSERT INTO assessments VALUES (?, ?, ?, 'profile', 'review', 1, 'policy-v1', ?, ?, NULL)`,
		);
		const insertDecision = db.prepare(
			`INSERT INTO operator_actions (action, subject_uri, subject_cid) VALUES ('approve', ?, ?)`,
		);
		for (let index = 0; index < 105; index += 1) {
			const key = `old-${index.toString().padStart(3, "0")}`;
			const uri = `at://did:plc:fixture/profile/${key}`;
			const timestamp = `2026-08-23T00:${String(index % 60).padStart(2, "0")}:00.000Z`;
			insertAssessment.run(key, uri, `cid-${key}`, timestamp, timestamp);
			insertDecision.run(uri, `cid-${key}`);
		}
		for (const [key, timestamp] of [
			["new-a", "2026-08-24T12:00:00.000Z"],
			["new-b", "2026-08-24T12:00:00.000Z"],
			["new-c", "2026-08-24T12:01:00.000Z"],
		] as const) {
			insertAssessment.run(
				key,
				`at://did:plc:fixture/profile/${key}`,
				`cid-${key}`,
				timestamp,
				timestamp,
			);
		}
		const reader = {
			async all(sql: string, bindings: readonly (string | number)[]) {
				return db.prepare(sql).all(...bindings);
			},
		};
		const first = await readOperatorAssessmentPage(reader, {
			state: "review",
			limit: 2,
		});
		expect(first.items.map((row) => row["run_key"])).toEqual(["new-a", "new-b"]);
		expect(first.nextCursor).toEqual(expect.any(String));
		const second = await readOperatorAssessmentPage(reader, {
			state: "review",
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.items.map((row) => row["run_key"])).toEqual(["new-c"]);
		db.close();
	});

	it("returns the committed manual decision summary on detail", async () => {
		const response = await handleOperatorApi(
			new Request(`https://labels.example/_admin/api/assessments/${RUN.runKey}`),
			{} as Env,
			{
				...dependencies(REVIEWER),
				getManualDecision: async () => ({
					action: "block",
					actorDid: "did:web:labels.example:operators:reviewer",
					actorRole: "reviewer",
					reason: "Displayed metadata impersonates another publisher",
					createdAt: "2026-08-24T12:00:00.000Z",
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			assessment: { runKey: RUN.runKey },
			manualDecision: {
				action: "block",
				reason: "Displayed metadata impersonates another publisher",
			},
		});
	});

	it("lists the effective latest manual decision with stable keyset pagination", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE assessments (
				run_key TEXT PRIMARY KEY,
				subject_uri TEXT NOT NULL,
				subject_cid TEXT NOT NULL,
				subject_kind TEXT NOT NULL,
				state TEXT NOT NULL,
				state_version INTEGER NOT NULL,
				policy_version TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT
			);
			CREATE TABLE operator_actions (
				id INTEGER PRIMARY KEY,
				action TEXT NOT NULL,
				subject_uri TEXT,
				subject_cid TEXT,
				created_at TEXT NOT NULL
			);
		`);
		const insertAssessment = db.prepare(
			`INSERT INTO assessments VALUES (?, ?, ?, 'profile', ?, 1, 'policy-v1', ?, ?, NULL)`,
		);
		const insertDecision = db.prepare(
			`INSERT INTO operator_actions
			   (id, action, subject_uri, subject_cid, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		const subjects = {
			approved: ["at://did:plc:fixture/profile/approved", "cid-approved"] as const,
			blocked: ["at://did:plc:fixture/profile/blocked", "cid-blocked"] as const,
			rawBlocked: ["at://did:plc:fixture/profile/raw-blocked", "cid-raw-blocked"] as const,
			pending: ["at://did:plc:fixture/profile/pending", "cid-pending"] as const,
		};
		insertAssessment.run(
			"approved-latest",
			...subjects.approved,
			"review",
			"2026-08-24T11:59:00.000Z",
			"2026-08-24T11:59:00.000Z",
		);
		insertAssessment.run(
			"blocked-latest",
			...subjects.blocked,
			"review",
			"2026-08-24T12:00:00.000Z",
			"2026-08-24T12:00:00.000Z",
		);
		insertAssessment.run(
			"blocked-raw",
			...subjects.rawBlocked,
			"blocked",
			"2026-08-24T12:01:00.000Z",
			"2026-08-24T12:01:00.000Z",
		);
		insertAssessment.run(
			"pending-review",
			...subjects.pending,
			"review",
			"2026-08-24T12:02:00.000Z",
			"2026-08-24T12:02:00.000Z",
		);

		insertDecision.run(1, "block", ...subjects.approved, "2026-08-24T10:00:00.000Z");
		insertDecision.run(2, "approve", ...subjects.approved, "2026-08-24T11:00:00.000Z");
		insertDecision.run(3, "approve", ...subjects.blocked, "2026-08-24T11:00:00.000Z");
		insertDecision.run(4, "block", ...subjects.blocked, "2026-08-24T11:00:00.000Z");

		const reader = {
			async all(sql: string, bindings: readonly (string | number)[]) {
				return db.prepare(sql).all(...bindings);
			},
		};
		const review = await readOperatorAssessmentPage(reader, { state: "review", limit: 10 });
		expect(review.items.map((row) => row["run_key"])).toEqual(["pending-review"]);

		const passed = await readOperatorAssessmentPage(reader, { state: "passed", limit: 10 });
		expect(passed.items).toMatchObject([{ run_key: "approved-latest", state: "passed" }]);

		const firstBlocked = await readOperatorAssessmentPage(reader, {
			state: "blocked",
			limit: 1,
		});
		expect(firstBlocked.items).toMatchObject([{ run_key: "blocked-latest", state: "blocked" }]);
		expect(firstBlocked.nextCursor).toEqual(expect.any(String));
		const secondBlocked = await readOperatorAssessmentPage(reader, {
			state: "blocked",
			limit: 1,
			cursor: firstBlocked.nextCursor,
		});
		expect(secondBlocked.items).toMatchObject([{ run_key: "blocked-raw", state: "blocked" }]);
		expect(secondBlocked.nextCursor).toBeUndefined();
		db.close();
	});
});

describe("operator rerun idempotency", () => {
	it("replays concurrent identical claims after insert-if-absent", async () => {
		const store = memoryRerunStore();
		const input = rerunClaim();
		await expect(
			Promise.all([
				claimRerunIdempotency(store, input),
				claimRerunIdempotency(store, {
					...input,
					createdAt: "2026-08-24T12:00:01.000Z",
				}),
			]),
		).resolves.toEqual([undefined, undefined]);
		expect(store.insertIfAbsent).toHaveBeenCalledTimes(2);
		expect(store.read).toHaveBeenCalledTimes(2);
	});

	it("rejects a key concurrently committed for a different rerun", async () => {
		const store = memoryRerunStore();
		await claimRerunIdempotency(store, rerunClaim());
		await expect(
			claimRerunIdempotency(store, {
				...rerunClaim(),
				reason: "Different reason",
			}),
		).rejects.toThrow(/another action/);
	});
});

function operatorRequest(path: string, body: Record<string, unknown>): Request {
	return new Request(`https://labels.example${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "https://labels.example",
			"X-EmDash-Request": "1",
			"Idempotency-Key": "operator-request-123",
		},
		body: JSON.stringify(body),
	});
}

function dependencies(
	identity: OperatorIdentity,
	issuerOverrides: Record<string, unknown> = {},
): OperatorApiDependencies {
	return {
		authenticate: async () => identity,
		actorDid: async () => "did:web:labels.emdashcms.com:operators:fixture",
		getRun: async () => RUN,
		isCurrentSubject: async () => true,
		issuer: {
			approve: async () => ({ action: "approve", operatorActionId: 1, labels: [] }),
			block: async () => ({ action: "block", operatorActionId: 2, labels: [] }),
			issue: async () => {
				throw new Error("not used");
			},
			...issuerOverrides,
		},
		rerun: async () => "rerun-fixture",
		now: () => new Date("2026-08-24T12:00:00.000Z"),
	};
}

function rerunClaim(): OperatorActionRecord {
	return {
		actorDid: "did:web:labels.example:operators:reviewer",
		actorRole: "reviewer",
		action: "rerun",
		subjectUri: RUN.subject.uri,
		subjectCid: RUN.subject.cid,
		reason: "Re-evaluate exact metadata",
		idempotencyKey: "rerun-request-123",
		createdAt: "2026-08-24T12:00:00.000Z",
	};
}

function memoryRerunStore(): OperatorRerunActionStore & {
	insertIfAbsent: ReturnType<typeof vi.fn<OperatorRerunActionStore["insertIfAbsent"]>>;
	read: ReturnType<typeof vi.fn<OperatorRerunActionStore["read"]>>;
} {
	const rows = new Map<string, OperatorActionRecord>();
	const insertIfAbsent = vi.fn<OperatorRerunActionStore["insertIfAbsent"]>(async (input) => {
		if (!rows.has(input.idempotencyKey)) rows.set(input.idempotencyKey, input);
	});
	const read = vi.fn<OperatorRerunActionStore["read"]>(async (idempotencyKey) =>
		rows.get(idempotencyKey),
	);
	return { insertIfAbsent, read };
}
