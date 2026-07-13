import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
	completeReviewCheck: vi.fn(),
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
	readAppCreds: vi.fn().mockReturnValue({ appId: "1", installationId: "2", privateKey: "key" }),
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
		this.alarm = undefined;
	}
}

function setup() {
	const storage = new MemoryStorage();
	const ctx = { storage };
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
			await watchdog.finish(attempt.attemptId, {
				conclusion: "timed_out",
				summary: "timed out",
			}),
		).toBe(true);
		expect(
			await watchdog.finish(attempt.attemptId, {
				conclusion: "success",
				summary: "late success",
			}),
		).toBe(false);
		expect(await watchdog.heartbeat(attempt.attemptId, "posting_review")).toBe(false);
		expect(github.completeReviewCheck).toHaveBeenCalledTimes(1);
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "timed_out" },
			terminalReportedAt: expect.any(Number),
		});
	});

	it("persists a failed terminal update for alarm retry", async () => {
		const { attempt, storage, watchdog } = setup();
		await watchdog.reserve(attempt, "lease-1");
		github.completeReviewCheck.mockRejectedValueOnce(new Error("GitHub unavailable"));

		await expect(
			watchdog.finish(attempt.attemptId, { conclusion: "failure", summary: "failed" }),
		).rejects.toThrow("GitHub unavailable");
		expect(storage.alarm).toBeTypeOf("number");
		expect(storage.values.get("attempt")).toMatchObject({
			terminal: { conclusion: "failure" },
		});

		await watchdog.alarm();
		expect(github.completeReviewCheck).toHaveBeenCalledTimes(2);
		expect(storage.values.get("attempt")).toMatchObject({
			terminalReportedAt: expect.any(Number),
		});
		expect(storage.alarm).toBeUndefined();
	});
});
