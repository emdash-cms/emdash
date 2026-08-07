import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
	completeReviewCheck: vi.fn(),
	readAppCreds: vi.fn(),
	removePullRequestLabel: vi.fn(),
	updateReviewCheck: vi.fn(),
}));
const workflow = vi.hoisted(() => ({
	admitReviewWorkflow: vi.fn(),
}));
const flue = vi.hoisted(() => ({
	getRun: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;

		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("../.flue/lib/github.js", () => ({
	completeReviewCheck: github.completeReviewCheck,
	mintInstallationToken: vi.fn().mockResolvedValue("token"),
	readAppCreds: github.readAppCreds,
	removePullRequestLabel: github.removePullRequestLabel,
	updateReviewCheck: github.updateReviewCheck,
}));

vi.mock("../.flue/lib/workflow-admission.js", () => ({
	admitReviewWorkflow: workflow.admitReviewWorkflow,
}));

vi.mock("@flue/runtime", () => ({
	getRun: flue.getRun,
}));

import { ReviewWatchdog } from "../.flue/cloudflare.js";
import type { ReviewAttempt } from "../.flue/lib/review-watchdog.js";

class MemoryStorage {
	values = new Map<string, unknown>();
	alarm: number | undefined;

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}

	async setAlarm(alarm: number): Promise<void> {
		this.alarm = alarm;
	}

	async deleteAlarm(): Promise<void> {
		this.alarm = undefined;
	}

	async deleteAll(): Promise<void> {
		this.values.clear();
	}
}

function setup() {
	const storage = new MemoryStorage();
	const ctx = { storage, waitUntil: vi.fn() };
	const watchdog = new ReviewWatchdog(ctx as unknown as DurableObjectState, {} as unknown as Env);
	const attempt: ReviewAttempt = {
		attemptId: "attempt-1",
		runId: "run-1",
		deliveryId: "delivery-1",
		owner: "emdash-cms",
		repo: "emdash",
		prNumber: 42,
		headSha: "a".repeat(40),
		checkRunId: 123,
		stage: "model_review",
		lastProgressAt: Date.now(),
	};
	return { attempt, storage, watchdog };
}

beforeEach(() => {
	github.completeReviewCheck.mockReset().mockResolvedValue(undefined);
	github.removePullRequestLabel.mockReset().mockResolvedValue(undefined);
	github.updateReviewCheck.mockReset().mockResolvedValue(undefined);
	github.readAppCreds.mockReset().mockReturnValue({
		appId: "1",
		installationId: "2",
		privateKey: "key",
	});
	workflow.admitReviewWorkflow
		.mockReset()
		.mockResolvedValue(Response.json({ runId: "run-2" }, { status: 202 }));
	flue.getRun.mockReset().mockResolvedValue({ status: "errored" });
});

describe("ReviewWatchdog terminal arbitration", () => {
	it("resumes incomplete setup but suppresses delivery after admission starts", async () => {
		const { attempt, watchdog } = setup();
		expect(await watchdog.reserve(attempt, "lease-1")).toMatchObject({
			status: "acquired",
			attempt,
		});
		expect(await watchdog.reserve(attempt, "lease-2")).toEqual({ status: "busy" });
		expect(await watchdog.beginAdmission(attempt.attemptId, "lease-1")).toBe(true);
		expect(await watchdog.reserve(attempt, "lease-2")).toEqual({ status: "complete" });
	});

	it("keeps the first terminal state and rejects late success", async () => {
		const { attempt, storage, watchdog } = setup();
		expect(await watchdog.reserve(attempt, "lease-1")).toMatchObject({ status: "acquired" });

		expect(
			await watchdog.finish(attempt.attemptId, attempt.runId, {
				conclusion: "timed_out",
				summary: "timed out",
			}),
		).toBe(true);
		expect(
			await watchdog.finish(attempt.attemptId, attempt.runId, {
				conclusion: "success",
				summary: "late success",
			}),
		).toBe(false);
		expect(await watchdog.heartbeat(attempt.attemptId, attempt.runId, "posting_review")).toBe(
			false,
		);
		expect(github.completeReviewCheck).toHaveBeenCalledTimes(1);
		expect(github.removePullRequestLabel).toHaveBeenCalledWith(
			"token",
			attempt.owner,
			attempt.repo,
			attempt.prNumber,
			"bot:review",
		);
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "timed_out" },
			terminalReportedAt: expect.any(Number),
		});
	});

	it("backs off failed terminal updates for alarm retry", async () => {
		const { attempt, storage, watchdog } = setup();
		await watchdog.reserve(attempt, "lease-1");
		github.completeReviewCheck.mockRejectedValue(new Error("GitHub unavailable"));

		await expect(
			watchdog.finish(attempt.attemptId, attempt.runId, {
				conclusion: "failure",
				summary: "failed",
			}),
		).resolves.toBe(true);
		const firstAlarm = storage.alarm;
		expect(firstAlarm).toBeTypeOf("number");
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "failure" },
			terminalRetryCount: 1,
		});

		await watchdog.alarm();
		expect(github.completeReviewCheck).toHaveBeenCalledTimes(2);
		expect(storage.values.get("attempt")).toMatchObject({
			terminalRetryCount: 2,
		});
		expect(storage.alarm).toBeGreaterThan(firstAlarm ?? 0);
	});

	it("abandons non-retryable terminal reporting failures", async () => {
		const { attempt, storage, watchdog } = setup();
		await watchdog.reserve(attempt, "lease-1");
		github.readAppCreds.mockReturnValue(null);

		await expect(
			watchdog.finish(attempt.attemptId, attempt.runId, {
				conclusion: "failure",
				summary: "failed",
			}),
		).resolves.toBe(true);
		expect(storage.values.get("attempt")).toMatchObject({
			terminalAbandonedAt: expect.any(Number),
		});
	});

	it("marks a stale active attempt as timed out", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(github.completeReviewCheck).toHaveBeenCalledWith(
			"token",
			"emdash-cms",
			"emdash",
			123,
			expect.objectContaining({ conclusion: "timed_out" }),
		);
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "timed_out" },
			terminalReportedAt: expect.any(Number),
		});
	});

	it("re-admits a stale workflow and fences the interrupted run", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.stage = "hydrating";
		attempt.lastProgressAt = 0;
		attempt.workflowInput = {
			prNumber: attempt.prNumber,
			prTitle: "Review retry",
			prBody: "",
			headRef: "fix/retry",
			headSha: attempt.headSha,
			baseRef: "main",
			baseSha: "b".repeat(40),
			owner: attempt.owner,
			repo: attempt.repo,
		};
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({ attemptId: attempt.attemptId, checkRunId: 123 }),
			expect.anything(),
			expect.anything(),
		);
		expect(github.completeReviewCheck).not.toHaveBeenCalled();
		expect(github.updateReviewCheck).toHaveBeenCalledWith(
			"token",
			attempt.owner,
			attempt.repo,
			attempt.checkRunId,
			expect.objectContaining({
				prNumber: attempt.prNumber,
				stage: "hydrating",
				detail:
					"The previous review stopped reporting progress. EmDashBot is starting a replacement run.",
			}),
		);
		expect(storage.values.get("attempt")).toMatchObject({
			runId: "run-2",
			stage: "admitted",
			workflowRetryCount: 1,
		});
		expect(await watchdog.heartbeat(attempt.attemptId, attempt.runId, "model_review")).toBe(false);
		expect(await watchdog.heartbeat(attempt.attemptId, "run-2", "hydrating")).toBe(true);
	});

	it("does not replace a stale workflow while its Flue run is active", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		attempt.workflowInput = {
			prNumber: attempt.prNumber,
			prTitle: "Active review",
			prBody: "",
			headRef: "fix/active",
			headSha: attempt.headSha,
			baseRef: "main",
			baseSha: "b".repeat(40),
			owner: attempt.owner,
			repo: attempt.repo,
		};
		flue.getRun.mockResolvedValue({ status: "active" });
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).not.toHaveBeenCalled();
		expect(github.completeReviewCheck).not.toHaveBeenCalled();
		expect(storage.alarm).toBeGreaterThan(Date.now());
	});

	it("reconciles a completed Flue run without repeating the review", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		flue.getRun.mockResolvedValue({ status: "completed" });
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).not.toHaveBeenCalled();
		expect(github.completeReviewCheck).toHaveBeenCalledWith(
			"token",
			attempt.owner,
			attempt.repo,
			attempt.checkRunId,
			expect.objectContaining({ conclusion: "success" }),
		);
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "success" },
		});
	});

	it("re-admits a completed Flue run marked as an error", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		attempt.workflowInput = {
			prNumber: attempt.prNumber,
			prTitle: "Errored review",
			prBody: "",
			headRef: "fix/errored",
			headSha: attempt.headSha,
			baseRef: "main",
			baseSha: "b".repeat(40),
			owner: attempt.owner,
			repo: attempt.repo,
		};
		flue.getRun.mockResolvedValue({ status: "completed", isError: true });
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).toHaveBeenCalledTimes(1);
		expect(github.completeReviewCheck).not.toHaveBeenCalled();
		expect(storage.values.get("attempt")).toMatchObject({
			runId: "run-2",
			workflowRetryCount: 1,
		});
	});

	it("rejects a delayed ownership claim from a superseded admission", async () => {
		const { attempt, storage, watchdog } = setup();
		await watchdog.reserve(attempt, "lease-1");

		expect(await watchdog.identify(attempt.attemptId, attempt.runId, "run-2")).toBe(true);
		expect(await watchdog.identify(attempt.attemptId, attempt.runId, "run-delayed")).toBe(false);
		expect(storage.values.get("attempt")).toMatchObject({ runId: "run-2" });
	});

	it("accepts repeated ownership claims for the same admitted run", async () => {
		const { attempt, watchdog } = setup();
		await watchdog.reserve(attempt, "lease-1");

		expect(await watchdog.identify(attempt.attemptId, attempt.runId, "run-2")).toBe(true);
		expect(await watchdog.identify(attempt.attemptId, attempt.runId, "run-2")).toBe(true);
	});

	it("preserves the replacement budget after a transient admission failure", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		attempt.workflowInput = {
			prNumber: attempt.prNumber,
			prTitle: "Retry admission",
			prBody: "",
			headRef: "fix/retry",
			headSha: attempt.headSha,
			baseRef: "main",
			baseSha: "b".repeat(40),
			owner: attempt.owner,
			repo: attempt.repo,
		};
		workflow.admitReviewWorkflow
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ runId: "run-3" }, { status: 202 }));
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(github.completeReviewCheck).not.toHaveBeenCalled();
		expect(storage.values.get("attempt")).toMatchObject({
			runId: `${attempt.attemptId}:retry:1`,
			workflowRetryCount: 1,
		});
		const retrying = storage.values.get("attempt") as ReviewAttempt;
		await storage.put("attempt", { ...retrying, lastProgressAt: 0 });
		flue.getRun.mockResolvedValue(null);

		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).toHaveBeenCalledTimes(2);
		expect(storage.values.get("attempt")).toMatchObject({
			runId: "run-3",
			workflowRetryCount: 2,
		});
	});

	it("times out after the bounded replacement budget is exhausted", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		attempt.workflowInput = {
			prNumber: attempt.prNumber,
			prTitle: "Exhaust admission",
			prBody: "",
			headRef: "fix/exhaust",
			headSha: attempt.headSha,
			baseRef: "main",
			baseSha: "b".repeat(40),
			owner: attempt.owner,
			repo: attempt.repo,
		};
		workflow.admitReviewWorkflow.mockResolvedValue(new Response("unavailable", { status: 503 }));
		flue.getRun.mockResolvedValue(null);
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();
		let retrying = storage.values.get("attempt") as ReviewAttempt;
		await storage.put("attempt", { ...retrying, lastProgressAt: 0 });
		await watchdog.alarm();
		retrying = storage.values.get("attempt") as ReviewAttempt;
		await storage.put("attempt", { ...retrying, lastProgressAt: 0 });
		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).toHaveBeenCalledTimes(2);
		expect(storage.values.get("attempt")).toMatchObject({
			workflowRetryCount: 2,
			terminal: { conclusion: "timed_out" },
		});
	});

	it("defers recovery when Flue run inspection is unavailable", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		flue.getRun.mockRejectedValue(new Error("registry unavailable"));
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).not.toHaveBeenCalled();
		expect(github.completeReviewCheck).not.toHaveBeenCalled();
		expect(storage.alarm).toBeGreaterThan(Date.now());
	});

	it("does not overwrite a terminal state recorded during run inspection", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		attempt.workflowInput = {
			prNumber: attempt.prNumber,
			prTitle: "Concurrent finish",
			prBody: "",
			headRef: "fix/concurrent",
			headSha: attempt.headSha,
			baseRef: "main",
			baseSha: "b".repeat(40),
			owner: attempt.owner,
			repo: attempt.repo,
		};
		let resolveRun: (run: { status: "errored" }) => void = () => undefined;
		flue.getRun.mockReturnValue(
			new Promise((resolve) => {
				resolveRun = resolve;
			}),
		);
		await watchdog.reserve(attempt, "lease-1");

		const alarm = watchdog.alarm();
		await vi.waitFor(() => expect(flue.getRun).toHaveBeenCalled());
		await watchdog.finish(attempt.attemptId, attempt.runId, {
			conclusion: "failure",
			summary: "workflow failed",
		});
		resolveRun({ status: "errored" });
		await alarm;

		expect(workflow.admitReviewWorkflow).not.toHaveBeenCalled();
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "failure" },
		});
	});

	it("terminalizes a Flue run that remains active beyond the hard ceiling", async () => {
		const { attempt, storage, watchdog } = setup();
		attempt.lastProgressAt = 0;
		attempt.workflowActiveStaleSince = Date.now() - 6 * 60_000;
		flue.getRun.mockResolvedValue({ status: "active" });
		await watchdog.reserve(attempt, "lease-1");

		await watchdog.alarm();

		expect(workflow.admitReviewWorkflow).not.toHaveBeenCalled();
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "timed_out" },
		});
	});

	it("clears a pending alarm when setup is completed", async () => {
		const { attempt, storage, watchdog } = setup();
		await watchdog.reserve(attempt, "lease-1");
		expect(storage.alarm).toBeTypeOf("number");

		await watchdog.complete(attempt.attemptId);

		expect(storage.alarm).toBeUndefined();
	});
});
