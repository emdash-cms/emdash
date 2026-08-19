import { describe, expect, test, vi } from "vitest";

import {
	attachWorkspaceWithRetry,
	prepareWorkspaceBeforeModel,
} from "../../.flue/lib/workspace-attachment.js";

describe("workspace attachment", () => {
	test("retries a transient platform failure on a fresh sandbox", async () => {
		const attached: string[] = [];
		const discarded: string[] = [];
		const retries: Array<{ attempt: number; sandboxId: string; error: unknown }> = [];
		const selected: number[] = [];

		const result = await attachWorkspaceWithRetry({
			agentId: "investigate-2535-run",
			startAttempt: 0,
			attach: async ({ sandboxId }) => {
				attached.push(sandboxId);
				if (attached.length === 1) {
					throw new Error("internal error; reference = gea98gkmk3dntv1v53lg72if");
				}
				return "ready";
			},
			discard: async ({ sandboxId }) => {
				discarded.push(sandboxId);
			},
			onRetry: async (event) => {
				retries.push(event);
			},
			onAttached: async ({ attempt }) => {
				selected.push(attempt);
			},
		});

		expect(result).toBe("ready");
		expect(attached).toEqual(["investigate-2535-run", "investigate-2535-run-r1"]);
		expect(discarded).toEqual(["investigate-2535-run"]);
		expect(retries).toMatchObject([
			{
				attempt: 1,
				sandboxId: "investigate-2535-run-r1",
				error: { message: "internal error; reference = gea98gkmk3dntv1v53lg72if" },
			},
		]);
		expect(selected).toEqual([1]);
	});

	test("does not retry a deterministic workspace command failure", async () => {
		const attach = vi.fn(async () => {
			throw new Error("dependency installation failed (1): frozen lockfile mismatch");
		});
		const discard = vi.fn(async () => {});

		await expect(
			attachWorkspaceWithRetry({
				agentId: "investigate-2535-run",
				startAttempt: 0,
				attach,
				discard,
			}),
		).rejects.toThrow("dependency installation failed (1): frozen lockfile mismatch");

		expect(attach).toHaveBeenCalledTimes(1);
		expect(discard).not.toHaveBeenCalled();
	});

	test("continues on a fresh sandbox when failed-sandbox cleanup also fails", async () => {
		const attached: string[] = [];
		const cleanupFailures: unknown[] = [];

		await expect(
			attachWorkspaceWithRetry({
				agentId: "investigate-2535-run",
				startAttempt: 0,
				attach: async ({ sandboxId }) => {
					attached.push(sandboxId);
					if (attached.length === 1) throw new Error("HTTP error! status: 500");
					return "ready";
				},
				discard: async () => {
					throw new Error("cleanup timed out");
				},
				onDiscardFailure: async ({ discardError }) => {
					cleanupFailures.push(discardError);
				},
			}),
		).resolves.toBe("ready");

		expect(attached).toEqual(["investigate-2535-run", "investigate-2535-run-r1"]);
		expect(cleanupFailures).toMatchObject([{ message: "cleanup timed out" }]);
	});

	test("reattaches to the persisted successful sandbox attempt", async () => {
		const attached: string[] = [];

		await attachWorkspaceWithRetry({
			agentId: "investigate-2535-run",
			startAttempt: 1,
			attach: async ({ sandboxId }) => {
				attached.push(sandboxId);
				return "ready";
			},
			discard: async () => {},
		});

		expect(attached).toEqual(["investigate-2535-run-r1"]);
	});

	test("bounds fresh sandbox retries and preserves the final platform reference", async () => {
		const attach = vi.fn(async ({ attempt }: { attempt: number; sandboxId: string }) => {
			throw new Error(`internal error; reference = failure${attempt}`);
		});

		await expect(
			attachWorkspaceWithRetry({
				agentId: "investigate-2535-run",
				startAttempt: 0,
				attach,
				discard: async () => {},
			}),
		).rejects.toThrow("internal error; reference = failure2");

		expect(attach.mock.calls.map(([attempt]) => attempt.sandboxId)).toEqual([
			"investigate-2535-run",
			"investigate-2535-run-r1",
			"investigate-2535-run-r2",
		]);
	});
});

describe("workspace setup gate", () => {
	test("reports an exhausted workspace failure and rejects before the model can start", async () => {
		const events: string[] = [];
		const error = new Error("internal error; reference = finalfailure");

		await expect(
			prepareWorkspaceBeforeModel({
				prepare: async () => {
					events.push("prepare");
					throw error;
				},
				onFailure: async (caught) => {
					expect(caught).toBe(error);
					events.push("report");
				},
			}),
		).rejects.toBe(error);

		expect(events).toEqual(["prepare", "report"]);
	});
});
