/**
 * Crash Budget Diagnostics Tests
 *
 * Pins what the runner reports once the crash budget is spent. Giving up
 * arms no invocation retry, while configuration changes can reset the
 * recovery budget and restart the runner.
 */

import { ChildProcess } from "node:child_process";

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

function stubSuccessfulRestart(runner: WorkerdSandboxRunner) {
	return vi.spyOn(runner as any, "restart").mockImplementation(async () => {
		const child = new ChildProcess();
		child.exitCode = 0;
		runner["healthy"] = true;
		runner["workerdProcess"] = child;
	});
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
		vi.spyOn(runner as any, "scheduleEagerStart").mockImplementation(() => {});
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

	it("does not bypass the give-up state when a restart is needed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exhaustCrashBudget(runner);

		vi.mocked((runner as any).ensureRunning).mockRestore();
		const restart = vi.spyOn(runner as any, "restart").mockResolvedValue(undefined);
		(runner as any).needsRestart = true;
		await runner.ensureRunning();

		expect(restart).not.toHaveBeenCalled();
		expect(runner.unavailableReason()).toContain("crashed 5 times in 60 seconds");

		const plugin = await runner.load(MANIFEST, "export default {};");
		await expect(plugin.invokeHook("content:afterSave", {})).rejects.toMatchObject({
			name: "SandboxUnavailableError",
		});
		expect(restart).not.toHaveBeenCalled();
	});

	it("does not replenish the budget for cached or no-op configuration changes", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exhaustCrashBudget(runner);

		await runner.load(MANIFEST, "changed code is ignored for a cached version");
		runner.setPluginActive(`${MANIFEST.id}:${MANIFEST.version}`, true);
		runner.setPluginActive("missing-plugin:1.0.0", true);
		runner.unloadPlugin("missing-plugin:1.0.0");

		expect((runner as any).gaveUp).toBe(true);
		expect((runner as any).crashCount).toBe(6);
	});

	it("lets a new plugin version recover a spent crash budget", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exhaustCrashBudget(runner);
		vi.mocked((runner as any).ensureRunning).mockRestore();
		const restart = stubSuccessfulRestart(runner);

		await runner.load({ ...MANIFEST, version: "2.0.0" }, "export default {};\n");
		await runner.ensureRunning();

		expect(restart).toHaveBeenCalledOnce();
		expect((runner as any).gaveUp).toBe(false);
		expect((runner as any).crashCount).toBe(0);
		expect(runner.isHealthy()).toBe(true);
	});

	it("recovers when unloading an existing plugin with another remaining", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await runner.load({ ...MANIFEST, id: "remaining-plugin" }, "export default {};\n");
		exhaustCrashBudget(runner);
		vi.mocked((runner as any).ensureRunning).mockRestore();
		const restart = stubSuccessfulRestart(runner);

		runner.unloadPlugin(`${MANIFEST.id}:${MANIFEST.version}`);
		await runner.ensureRunning();

		expect(restart).toHaveBeenCalledOnce();
		expect((runner as any).gaveUp).toBe(false);
		expect((runner as any).crashCount).toBe(0);
	});

	it("recovers when re-enabling a plugin after an inactive transition", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		runner.setPluginActive(`${MANIFEST.id}:${MANIFEST.version}`, false);
		exhaustCrashBudget(runner);
		vi.mocked((runner as any).ensureRunning).mockRestore();
		const restart = stubSuccessfulRestart(runner);

		runner.setPluginActive(`${MANIFEST.id}:${MANIFEST.version}`, true);
		await runner.ensureRunning();

		expect(restart).toHaveBeenCalledOnce();
		expect((runner as any).gaveUp).toBe(false);
		expect((runner as any).crashCount).toBe(0);
	});

	it("uses a fresh one-second backoff after configuration recovery", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exhaustCrashBudget(runner);
		vi.mocked((runner as any).ensureRunning).mockRestore();
		const restart = stubSuccessfulRestart(runner);
		await runner.load({ ...MANIFEST, version: "2.0.0" }, "export default {};\n");

		(runner as any).scheduleRestart();
		expect((runner as any).crashCount).toBe(1);
		expect((runner as any).gaveUp).toBe(false);
		await runner.ensureRunning();
		expect(restart).not.toHaveBeenCalled();

		vi.advanceTimersByTime(999);
		expect(restart).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await runner.ensureRunning();
		expect(restart).toHaveBeenCalledOnce();
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

	it("classifies a rejected hook transport as sandbox unavailable", async () => {
		vi.spyOn(runner, "isHealthy").mockReturnValue(true);
		vi.spyOn(runner, "getPluginPort").mockReturnValue(41001);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection lost"));
		const plugin = await runner.load(MANIFEST, "export default {};");

		await expect(plugin.invokeHook("content:afterSave", {})).rejects.toMatchObject({
			name: "SandboxUnavailableError",
		});
	});

	it("classifies a non-OK hook response as a plugin error", async () => {
		vi.spyOn(runner, "isHealthy").mockReturnValue(true);
		vi.spyOn(runner, "getPluginPort").mockReturnValue(41001);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hook failed", { status: 500 }));
		const plugin = await runner.load(MANIFEST, "export default {};");

		await expect(plugin.invokeHook("content:afterSave", {})).rejects.toMatchObject({
			name: "Error",
		});
	});
});
