import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

describe("scheduleEagerStart error handling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("cancels overlapping crash restart timers on termination", async () => {
		const runner = new WorkerdSandboxRunner({ db: null as any });
		runner["scheduleEagerStart"] = () => {};
		try {
			await runner.load({ id: "test-plugin", version: "1.0.0" } as any, "export default {};");
			runner["scheduleRestart"]();
			runner["scheduleRestart"]();
		} finally {
			await runner.terminateAll();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("logs an eager startup failure once and enters restart backoff", async () => {
		const runner = new WorkerdSandboxRunner({ db: null as never });
		const startError = new Error("simulated startup failure");
		vi.spyOn(runner as any, "restart").mockRejectedValue(startError);
		const scheduleRestartSpy = vi.spyOn(runner as any, "scheduleRestart");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await runner.load(
				{ id: "test-plugin", version: "1.0.0", capabilities: [], storage: {} },
				"export default {};",
			);
			await vi.advanceTimersByTimeAsync(60);

			expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
				"[emdash:workerd] startup failed:",
				startError,
			);
			expect(scheduleRestartSpy).toHaveBeenCalledTimes(1);
			expect(runner["crashCount"]).toBe(1);
			expect(runner["restartTimer"]).not.toBeNull();
		} finally {
			await runner.terminateAll();
		}
		expect(vi.getTimerCount()).toBe(0);
	});
});
