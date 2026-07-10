/**
 * Eager-Start Error Handling Tests
 *
 * Regression coverage for an unhandled-rejection bug in
 * `WorkerdSandboxRunner.scheduleEagerStart()`: the debounced timer body
 * used to do `void this.ensureRunning();`. If startup rejected (spawn
 * failure, ENOENT, capnp parse error, waitForReady timeout) the rejection
 * was silently swallowed -- bypassing the crashCount / scheduleRestart
 * accounting that handles post-spawn crashes, so the runner would stay
 * unhealthy with no automatic retry.
 *
 * The fix replaces the void with a `.catch()` that logs the error and
 * calls `scheduleRestart()` to engage the existing backoff machinery.
 */

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

	it("logs and triggers scheduleRestart when ensureRunning rejects", async () => {
		const runner = new WorkerdSandboxRunner({ db: null as any });
		const startError = new Error("simulated startup failure");

		// Stub ensureRunning to reject. The eager-start timer body calls
		// `this.ensureRunning()`, so monkey-patching is enough.
		vi.spyOn(runner as any, "ensureRunning").mockRejectedValue(startError);
		const scheduleRestartSpy = vi.spyOn(runner as any, "scheduleRestart").mockImplementation(() => {
			// no-op -- we just want to observe the call
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// Trigger scheduleEagerStart via the public load() path.
		await runner.load(
			{
				id: "test-plugin",
				name: "test",
				version: "1.0.0",
				capabilities: [],
				storage: {},
			} as any,
			"export default {};",
		);

		// Advance past the 50ms debounce; the async variant flushes microtasks
		// between ticks, so the `.catch` actually runs.
		await vi.advanceTimersByTimeAsync(60);

		expect(errorSpy).toHaveBeenCalled();
		const firstCall = errorSpy.mock.calls[0];
		expect(String(firstCall?.[0])).toContain("[emdash:workerd] eager start failed");
		expect(firstCall?.[1]).toBe(startError);

		expect(scheduleRestartSpy).toHaveBeenCalledTimes(1);

		// Cleanup. ensureRunning is stubbed so workerd was never spawned --
		// terminateAll() should be quick. Guard with try/catch in case stubbing
		// breaks a downstream assumption.
		try {
			await runner.terminateAll();
		} catch {
			// best-effort cleanup
		}
	});
});
