import { ChildProcess } from "node:child_process";

import type { PluginManifest } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

const MANIFEST: PluginManifest = {
	id: "restart-readiness",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [],
	admin: {},
};

function makeRunningProcess(): ChildProcess {
	const child = new ChildProcess();
	child.exitCode = 0;
	return child;
}

describe("workerd crash restart readiness", () => {
	let runner: WorkerdSandboxRunner;

	afterEach(async () => {
		await runner?.terminateAll();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function makeRunner(): Promise<WorkerdSandboxRunner> {
		vi.useFakeTimers();
		runner = new WorkerdSandboxRunner({ db: null as never });
		runner["scheduleEagerStart"] = () => {};
		await runner.load(MANIFEST, "export default {};");
		return runner;
	}

	it("waits for pending crash backoff and readiness, sharing the restart", async () => {
		await makeRunner();
		let resolveRestart!: () => void;
		const restartReady = new Promise<void>((resolve) => {
			resolveRestart = resolve;
		});
		const restart = vi.fn(async () => {
			await restartReady;
			runner["healthy"] = true;
			runner["workerdProcess"] = makeRunningProcess();
		});

		runner["restart"] = restart;
		runner["healthy"] = false;
		runner["workerdProcess"] = null;
		runner["needsRestart"] = false;
		runner["scheduleRestart"]();

		let settled = false;
		const running = Promise.all([runner.ensureRunning(), runner.ensureRunning()]).finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		expect(restart).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(restart).toHaveBeenCalledOnce();
		expect(settled).toBe(false);

		resolveRestart();
		await running;
		expect(settled).toBe(true);
		expect(runner.isHealthy()).toBe(true);
	});

	it("cancels a pending readiness wait when the runner terminates", async () => {
		await makeRunner();
		const restart = vi.fn(async () => undefined);
		runner["restart"] = restart;
		runner["healthy"] = false;
		runner["workerdProcess"] = null;
		runner["needsRestart"] = false;
		runner["scheduleRestart"]();

		let settled = false;
		const running = Promise.all([runner.ensureRunning(), runner.ensureRunning()]).finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);

		await runner.terminateAll();
		await running;
		expect(settled).toBe(true);
		expect(restart).not.toHaveBeenCalled();
	});

	it("does not restart after the last plugin is unloaded during backoff", async () => {
		await makeRunner();
		const restart = vi.fn(async () => undefined);
		runner["restart"] = restart;
		runner["needsRestart"] = false;
		runner["scheduleRestart"]();
		const running = runner.ensureRunning();
		runner.unloadPlugin(`${MANIFEST.id}:${MANIFEST.version}`);

		await vi.advanceTimersByTimeAsync(1000);
		await running;
		expect(restart).not.toHaveBeenCalled();
		expect(runner.isHealthy()).toBe(false);
	});

	it("keeps scheduleRestart backoff and crash budget unchanged", async () => {
		await makeRunner();
		const restart = vi.fn(async () => {
			runner["healthy"] = true;
			runner["workerdProcess"] = makeRunningProcess();
		});
		runner["restart"] = restart;
		const delays = [1_000, 2_000, 4_000, 8_000, 16_000];

		for (const [attempt, delay] of delays.entries()) {
			runner["healthy"] = false;
			runner["workerdProcess"] = null;
			runner["needsRestart"] = false;
			runner["scheduleRestart"]();
			const running = runner.ensureRunning();

			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(restart).toHaveBeenCalledTimes(attempt);
			await vi.advanceTimersByTimeAsync(1);
			await running;
			expect(restart).toHaveBeenCalledTimes(attempt + 1);
		}

		runner["healthy"] = false;
		runner["workerdProcess"] = null;
		runner["needsRestart"] = false;
		runner["scheduleRestart"]();
		const gaveUp = runner.ensureRunning();
		await gaveUp;
		expect(restart).toHaveBeenCalledTimes(5);
		expect(runner.isHealthy()).toBe(false);
		expect(runner["gaveUp"]).toBe(true);
	});
});
