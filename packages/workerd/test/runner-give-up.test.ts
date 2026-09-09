/**
 * Crash Budget Diagnostics Tests
 *
 * Pins what the runner reports once the crash budget is spent. Giving up
 * arms no retry and leaves `needsRestart` false, so `ensureRunning()`
 * starts nothing and every hook and route throws `SandboxUnavailableError`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

const MANIFEST = {
	id: "test-plugin",
	name: "test",
	version: "1.0.0",
	capabilities: [],
	storage: {},
} as any;

/** Spend the crash budget: the first call opens the 60s window, the sixth exceeds it. */
function exhaustCrashBudget(runner: WorkerdSandboxRunner): void {
	for (let i = 0; i < 6; i++) {
		(runner as any).scheduleRestart();
	}
}

describe("crash budget diagnostics", () => {
	let runner: WorkerdSandboxRunner;

	beforeEach(async () => {
		vi.useFakeTimers();
		runner = new WorkerdSandboxRunner({ db: null as any });
		// scheduleRestart() returns early on an empty plugin map, so a
		// registered plugin is a precondition; the stub keeps the
		// ensureReady() behind an invocation from starting workerd for real.
		vi.spyOn(runner as any, "ensureRunning").mockResolvedValue(undefined);
		await runner.load(MANIFEST, "export default {};");
	});

	afterEach(async () => {
		try {
			await runner.terminateAll();
		} catch {
			// Nothing was spawned.
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("logs the failure mode when the crash budget is spent", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		exhaustCrashBudget(runner);

		const message = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(message).toContain("giving up");
		expect(message).toContain("SandboxUnavailableError");
		expect(message).not.toContain("unsandboxed");
	});

	it("distinguishes a spent crash budget from a runner that never started", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(runner.unavailableReason()).toBe("workerd is not running");

		exhaustCrashBudget(runner);

		expect(runner.unavailableReason()).toContain("crashed 5 times in 60 seconds");
		expect(runner.unavailableReason()).toContain("restart the server");
	});

	it("carries the reason into the error an invocation throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const plugin = await runner.load(MANIFEST, "export default {};");

		exhaustCrashBudget(runner);

		await expect(plugin.invokeHook("content:afterSave", {})).rejects.toThrow(
			/crashed 5 times in 60 seconds/,
		);
	});

	it("clears the give-up state once workerd starts again", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exhaustCrashBudget(runner);

		vi.mocked((runner as any).ensureRunning).mockRestore();
		vi.spyOn(runner as any, "restart").mockResolvedValue(undefined);
		(runner as any).needsRestart = true;
		await runner.ensureRunning();

		expect(runner.unavailableReason()).toBe("workerd is not running");
	});

	it("stops naming a spent budget once the crash window reopens", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exhaustCrashBudget(runner);
		expect(runner.unavailableReason()).toContain("crashed 5 times in 60 seconds");

		// 60 quiet seconds reopen the window, so the next crash is retried again.
		vi.advanceTimersByTime(60_001);
		(runner as any).scheduleRestart();

		expect(runner.unavailableReason()).toBe("workerd is not running");
	});
});
