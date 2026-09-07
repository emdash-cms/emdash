import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { CronExecutor } from "../../../src/plugins/cron.js";
import { NodeCronScheduler } from "../../../src/plugins/scheduler/node.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("NodeCronScheduler", () => {
	let db: Kysely<Database>;
	let executor: CronExecutor;
	let scheduler: NodeCronScheduler;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
		db = await setupTestDatabase();
		executor = new CronExecutor(db, async () => {});
		vi.spyOn(executor, "getNextDueTime").mockResolvedValue(null);
		vi.spyOn(executor, "tick").mockResolvedValue(0);
		vi.spyOn(executor, "recoverStaleLocks").mockResolvedValue(0);
		scheduler = new NodeCronScheduler(executor);
	});

	afterEach(async () => {
		scheduler.stop();
		vi.useRealTimers();
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("runs the general tick, stale-lock recovery, and cleanup together", async () => {
		const cleanup = vi.fn(async () => {});
		vi.mocked(executor.getNextDueTime).mockResolvedValue(new Date(Date.now()).toISOString());
		scheduler.setSystemCleanup(cleanup);
		scheduler.start();

		await vi.advanceTimersByTimeAsync(1_000);

		expect(executor.tick).toHaveBeenCalledOnce();
		expect(executor.recoverStaleLocks).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("uses the one-minute heartbeat when no task is due", async () => {
		scheduler.start();

		await vi.advanceTimersByTimeAsync(59_999);
		expect(executor.tick).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(executor.tick).toHaveBeenCalledOnce();
	});

	it("reschedules from a newly due task", async () => {
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		vi.mocked(executor.getNextDueTime).mockResolvedValue(
			new Date(Date.now() + 2_000).toISOString(),
		);

		scheduler.reschedule();
		await vi.advanceTimersByTimeAsync(1_999);
		expect(executor.tick).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(executor.tick).toHaveBeenCalledOnce();
	});

	it("cancels the pending heartbeat when stopped", async () => {
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);

		scheduler.stop();
		await vi.runAllTimersAsync();

		expect(executor.tick).not.toHaveBeenCalled();
	});

	it("unrefs the heartbeat timer", async () => {
		const timeout = vi.spyOn(globalThis, "setTimeout");
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);

		const heartbeat = timeout.mock.results.find(
			(result, index) =>
				timeout.mock.calls[index]?.[1] === 60_000 && isUnreferencedTimer(result.value),
		);
		expect(heartbeat).toBeDefined();
	});

	it("logs failed heartbeat tasks and schedules the next heartbeat", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(executor.tick).mockRejectedValueOnce(new Error("tick failed"));
		vi.mocked(executor.recoverStaleLocks).mockRejectedValueOnce(new Error("recovery failed"));
		scheduler.setSystemCleanup(async () => {
			throw new Error("cleanup failed");
		});
		scheduler.start();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(error).toHaveBeenCalledTimes(3);
		expect(executor.getNextDueTime).toHaveBeenCalledTimes(2);
	});
});

function isUnreferencedTimer(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("hasRef" in value)) return false;
	const hasRef = value.hasRef;
	return typeof hasRef === "function" && hasRef.call(value) === false;
}
