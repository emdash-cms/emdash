import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { CronExecutor } from "../../../src/plugins/cron.js";
import { NodeCronScheduler } from "../../../src/plugins/scheduler/node.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("NodeCronScheduler Media Usage continuation", () => {
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

	it("yields to a new timer turn between immediate units", async () => {
		const maintenance = vi
			.fn()
			.mockResolvedValueOnce({ kind: "immediate" } as const)
			.mockResolvedValueOnce({ kind: "none" } as const);
		scheduler.setContinuousMediaUsageMaintenance(maintenance);
		scheduler.start();

		await vi.advanceTimersToNextTimerAsync();
		expect(maintenance).toHaveBeenCalledTimes(1);
		await vi.advanceTimersToNextTimerAsync();
		expect(maintenance).toHaveBeenCalledTimes(2);
	});

	it("does not let heartbeats shorten a delayed continuation", async () => {
		vi.mocked(executor.getNextDueTime).mockImplementation(async () =>
			new Date(Date.now()).toISOString(),
		);
		const maintenance = vi
			.fn()
			.mockResolvedValueOnce({ kind: "delayed", delaySeconds: 30 } as const)
			.mockResolvedValue({ kind: "none" } as const);
		scheduler.setContinuousMediaUsageMaintenance(maintenance);
		scheduler.start();

		await vi.advanceTimersToNextTimerAsync();
		expect(maintenance).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29_000);
		expect(maintenance).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(maintenance).toHaveBeenCalledTimes(2);
	});

	it("keeps general heartbeats running without overlapping a held unit", async () => {
		vi.mocked(executor.getNextDueTime).mockImplementation(async () =>
			new Date(Date.now()).toISOString(),
		);
		let releaseFirst!: () => void;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let active = 0;
		let maximumActive = 0;
		const maintenance = vi.fn(async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			if (maintenance.mock.calls.length === 1) await first;
			active--;
			return { kind: "none" } as const;
		});
		const cleanup = vi.fn(async () => {});
		scheduler.setSystemCleanup(cleanup);
		scheduler.setContinuousMediaUsageMaintenance(maintenance);
		scheduler.start();

		await vi.advanceTimersToNextTimerAsync();
		expect(maintenance).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(executor.tick).toHaveBeenCalledTimes(4);
		expect(cleanup).toHaveBeenCalledTimes(4);
		expect(maximumActive).toBe(1);

		releaseFirst();
		await vi.advanceTimersByTimeAsync(0);
		expect(maintenance).toHaveBeenCalledTimes(2);
		expect(maximumActive).toBe(1);
	});

	it("clears a pending continuation when stopped", async () => {
		const maintenance = vi.fn().mockResolvedValue({ kind: "immediate" } as const);
		scheduler.setContinuousMediaUsageMaintenance(maintenance);
		scheduler.start();

		await vi.advanceTimersToNextTimerAsync();
		expect(maintenance).toHaveBeenCalledTimes(1);
		scheduler.stop();
		await vi.runAllTimersAsync();
		expect(maintenance).toHaveBeenCalledTimes(1);
	});

	it("unrefs Media Usage continuation timers", async () => {
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const maintenance = vi.fn().mockResolvedValue({ kind: "none" } as const);
		scheduler.setContinuousMediaUsageMaintenance(maintenance);
		scheduler.start();

		await vi.advanceTimersToNextTimerAsync();
		const mediaTimerIndex = timeout.mock.calls.findIndex((call) => call[1] === 0);
		expect(mediaTimerIndex).toBeGreaterThanOrEqual(0);
		expect(isUnreferencedTimer(timeout.mock.results[mediaTimerIndex]?.value)).toBe(true);
	});

	it("logs a failed unit once and waits for heartbeat recovery", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const maintenance = vi
			.fn()
			.mockRejectedValueOnce(new Error("maintenance failed"))
			.mockResolvedValue({ kind: "none" } as const);
		scheduler.setContinuousMediaUsageMaintenance(maintenance);
		scheduler.start();

		await vi.advanceTimersToNextTimerAsync();
		expect(maintenance).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(maintenance).toHaveBeenCalledTimes(1);
		await vi.advanceTimersToNextTimerAsync();
		expect(maintenance).toHaveBeenCalledTimes(2);
		expect(error).toHaveBeenCalledTimes(1);
	});
});

function isUnreferencedTimer(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("hasRef" in value)) return false;
	const hasRef = value.hasRef;
	return typeof hasRef === "function" && hasRef.call(value) === false;
}
