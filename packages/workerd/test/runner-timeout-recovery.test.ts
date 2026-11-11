import { ChildProcess } from "node:child_process";

import type { PluginManifest } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeWorkerdExitHandler, WorkerdSandboxRunner } from "../src/sandbox/runner.js";
import type { ExitHandlerHost } from "../src/sandbox/runner.js";

const MANIFEST: PluginManifest = {
	id: "timeout-recovery",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: ["ping"],
	admin: {},
};

const REQUEST = { method: "GET", url: "/ping", headers: {} };

function fakeProcess(): ChildProcess {
	const proc = new ChildProcess();
	proc.exitCode = null;
	vi.spyOn(proc, "kill").mockImplementation((signal) => {
		proc.emit("exit", null, signal);
		return true;
	});
	return proc;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("workerd timeout recovery", () => {
	let runner: WorkerdSandboxRunner | undefined;

	afterEach(async () => {
		await runner?.terminateAll();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function setup(): Promise<{
		plugin: Awaited<ReturnType<WorkerdSandboxRunner["load"]>>;
		oldProcess: ChildProcess;
		pendingFetches: Array<() => void>;
	}> {
		vi.useFakeTimers();
		runner = new WorkerdSandboxRunner({ db: null as never, limits: { wallTimeMs: 100 } });
		runner["scheduleEagerStart"] = () => {};
		const plugin = await runner.load(MANIFEST, "export default {};");
		const oldProcess = fakeProcess();
		runner["workerdProcess"] = oldProcess;
		runner["healthy"] = true;
		runner["needsRestart"] = false;
		runner["epoch"] = 1;
		runner["plugins"].get("timeout-recovery:1.0.0")!.port = 4100;
		const pendingFetches: Array<() => void> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.includes(":4100/")) {
					return new Promise<Response>((resolve) => {
						pendingFetches.push(() => resolve(new Response('{"ok":true}')));
					});
				}
				return Promise.resolve(new Response('{"ok":true}'));
			}),
		);
		return { plugin, oldProcess, pendingFetches };
	}

	it("waits during recovery and invokes only the replacement listener", async () => {
		const { plugin, oldProcess, pendingFetches } = await setup();
		let releaseRestart!: () => void;
		const restartGate = new Promise<void>((resolve) => {
			releaseRestart = resolve;
		});
		runner!["restart"] = vi.fn(async () => {
			await restartGate;
			runner!["epoch"] = 2;
			runner!["workerdProcess"] = fakeProcess();
			runner!["healthy"] = true;
			runner!["plugins"].get("timeout-recovery:1.0.0")!.port = 4200;
		});

		const timedOut = plugin.invokeRoute("ping", {}, REQUEST);
		void timedOut.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(timedOut).rejects.toThrow("exceeded wall-time limit of 100ms");
		expect(oldProcess.kill).toHaveBeenCalledWith("SIGKILL");

		let replacementSettled = false;
		const replacementCall = plugin.invokeRoute("ping", {}, REQUEST).finally(() => {
			replacementSettled = true;
		});
		await flush();
		expect(replacementSettled).toBe(false);
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(replacementSettled).toBe(false);
		releaseRestart();
		await replacementCall;
		expect(replacementSettled).toBe(true);
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
		expect(pendingFetches).toHaveLength(1);
		pendingFetches.forEach((settle) => settle());
	});

	it("does not revive workerd if shutdown occurs during recovery", async () => {
		const { plugin, pendingFetches } = await setup();
		let releaseRestart!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseRestart = resolve;
		});
		const restart = runner!["restart"].bind(runner!);
		runner!["restart"] = async () => {
			await gate;
			await restart();
		};
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit");
		await runner!.terminateAll();
		releaseRestart();
		await runner!["startupPromise"];
		expect(runner!["workerdProcess"]).toBeNull();
		expect(runner!["backingServer"]).toBeNull();
		pendingFetches.forEach((settle) => settle());
	});

	it("preserves the caller timeout if recovery throws", async () => {
		const { plugin, pendingFetches } = await setup();
		const recoveryError = new Error("cannot stop workerd");
		vi.spyOn(runner!, "recoverFromTimeout").mockImplementation(() => {
			throw recoveryError;
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit of 100ms");
		expect(log).toHaveBeenCalledWith("[emdash:workerd] timeout recovery failed:", recoveryError);
		pendingFetches.forEach((settle) => settle());
	});

	it("does not let a late old timeout kill the replacement", async () => {
		const { plugin, oldProcess, pendingFetches } = await setup();
		const restart = vi.fn(async () => {
			runner!["epoch"] = 2;
			runner!["workerdProcess"] = fakeProcess();
			runner!["healthy"] = true;
			runner!["plugins"].get("timeout-recovery:1.0.0")!.port = 4200;
		});
		runner!["restart"] = restart;

		const first = plugin.invokeRoute("ping", {}, REQUEST);
		void first.catch(() => {});
		await vi.advanceTimersByTimeAsync(50);
		const second = plugin.invokeRoute("ping", {}, REQUEST);
		void second.catch(() => {});
		await vi.advanceTimersByTimeAsync(50);
		await expect(first).rejects.toThrow("exceeded wall-time limit");
		await flush();
		await vi.advanceTimersByTimeAsync(50);
		await expect(second).rejects.toThrow("exceeded wall-time limit");
		await flush();

		expect(oldProcess.kill).toHaveBeenCalledOnce();
		expect(restart).toHaveBeenCalledOnce();
		expect(runner!["crashCount"]).toBe(0);
		expect(pendingFetches).toHaveLength(2);
		pendingFetches.forEach((settle) => settle());
	});

	it("does not count intentional timeout recovery as a crash, but does recover replacement crashes", async () => {
		const { plugin, oldProcess, pendingFetches } = await setup();
		const scheduleRestart = vi.spyOn(runner as any, "scheduleRestart");
		oldProcess.on("exit", makeWorkerdExitHandler(runner as unknown as ExitHandlerHost, oldProcess));
		let replacement!: ChildProcess;
		runner!["restart"] = vi.fn(async () => {
			runner!["epoch"] = 2;
			replacement = fakeProcess();
			runner!["workerdProcess"] = replacement;
			runner!["healthy"] = true;
			runner!["plugins"].get("timeout-recovery:1.0.0")!.port = 4200;
			replacement.on(
				"exit",
				makeWorkerdExitHandler(runner as unknown as ExitHandlerHost, replacement),
			);
		});

		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit");
		await flush();
		expect(scheduleRestart).not.toHaveBeenCalled();
		expect(runner!["crashCount"]).toBe(0);

		replacement.emit("exit", 1, null);
		expect(scheduleRestart).toHaveBeenCalledOnce();
		expect(runner!["crashCount"]).toBe(1);
		expect(pendingFetches).toHaveLength(1);
		pendingFetches.forEach((settle) => settle());
	});
});
