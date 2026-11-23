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
	await vi.advanceTimersByTimeAsync(0);
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
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
		pendingProbes: Array<() => void>;
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
		const pendingProbes: Array<() => void> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/__ready")) {
					return Promise.resolve(new Response("", { status: 503 }));
				}
				if (url.includes(":4100/")) {
					return new Promise<Response>((resolve) => {
						pendingFetches.push(() => resolve(new Response('{"ok":true}')));
					});
				}
				return Promise.resolve(new Response('{"ok":true}'));
			}),
		);
		return { plugin, oldProcess, pendingFetches, pendingProbes };
	}

	function useResponsiveProbe(): void {
		vi.mocked(fetch).mockImplementation((input) => {
			const url = requestUrl(input);
			if (url.endsWith("/__ready")) return Promise.resolve(new Response("", { status: 200 }));
			return new Promise<Response>(() => {});
		});
	}

	it("rejects at the initial deadline without killing a responsive process", async () => {
		const { plugin, oldProcess } = await setup();
		useResponsiveProbe();
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});

		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit of 100ms");
		await flush();
		expect(oldProcess.kill).not.toHaveBeenCalled();
	});

	it("measures the grace period from the timeout, not from probe completion", async () => {
		const { plugin, oldProcess } = await setup();
		const probe = deferred<Response>();
		vi.mocked(fetch).mockImplementation((input) =>
			requestUrl(input).endsWith("/__ready") ? probe.promise : new Promise<Response>(() => {}),
		);
		const replacement = fakeProcess();
		const restart = vi.fn(async () => {
			runner!["epoch"] = 2;
			runner!["workerdProcess"] = replacement;
			runner!["healthy"] = true;
			runner!["plugins"].get("timeout-recovery:1.0.0")!.port = 4200;
		});
		runner!["restart"] = restart;
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});

		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit of 100ms");
		await vi.advanceTimersByTimeAsync(50);
		probe.resolve(new Response("", { status: 200 }));
		await flush();
		await vi.advanceTimersByTimeAsync(49);
		expect(oldProcess.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await flush();

		expect(oldProcess.kill).toHaveBeenCalledWith("SIGKILL");
		expect(restart).toHaveBeenCalledOnce();
		expect(replacement.kill).not.toHaveBeenCalled();
	});

	it.each(["fulfills", "rejects"])(
		"cancels the grace watchdog when invocation %s",
		async (outcome) => {
			const { plugin, oldProcess } = await setup();
			const settled = deferred<Response>();
			vi.mocked(fetch).mockImplementation((input) =>
				requestUrl(input).endsWith("/__ready")
					? Promise.resolve(new Response("", { status: 200 }))
					: settled.promise,
			);
			const invocation = plugin.invokeRoute("ping", {}, REQUEST);
			void invocation.catch(() => {});
			await vi.advanceTimersByTimeAsync(100);
			await expect(invocation).rejects.toThrow("exceeded wall-time limit");
			await flush();
			if (outcome === "fulfills") settled.resolve(new Response('{"ok":true}'));
			else settled.reject(new Error("request failed"));
			await flush();
			await vi.advanceTimersByTimeAsync(100);

			expect(oldProcess.kill).not.toHaveBeenCalled();
			expect(runner!["timeoutWatchdogs"]).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each<
		[string, (current: WorkerdSandboxRunner, oldProcess: ChildProcess) => ChildProcess | void]
	>([
		["the epoch changes", (current) => void (current["epoch"] = 2)],
		[
			"the process is replaced",
			(current) => {
				const replacement = fakeProcess();
				current["workerdProcess"] = replacement;
				return replacement;
			},
		],
		["the process is cleared", (current) => void (current["workerdProcess"] = null)],
		["shutdown starts", (current) => void (current["shuttingDown"] = true)],
	])("does not kill or restart when %s before the grace kill", async (_, changeState) => {
		const { plugin, oldProcess } = await setup();
		useResponsiveProbe();
		const restart = vi.fn(async () => {});
		runner!["restart"] = restart;
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit");
		await flush();
		const replacement = changeState(runner!, oldProcess);
		await vi.advanceTimersByTimeAsync(100);
		await flush();

		expect(oldProcess.kill).not.toHaveBeenCalled();
		if (replacement) expect(replacement.kill).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
		expect(runner!["needsRestart"]).toBe(false);
	});

	it("clears the grace watchdog on shutdown without respawning", async () => {
		const { plugin, oldProcess } = await setup();
		useResponsiveProbe();
		const restart = vi.fn(async () => {});
		runner!["restart"] = restart;
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit");
		await flush();
		await runner!.terminateAll();
		expect(runner!["timeoutWatchdogs"]).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(100);
		expect(oldProcess.kill).not.toHaveBeenCalledWith("SIGKILL");
		expect(restart).not.toHaveBeenCalled();
	});

	it("does not run the grace watchdog after an unresponsive probe kills first", async () => {
		const { plugin, oldProcess } = await setup();
		const replacement = fakeProcess();
		const restart = vi.fn(async () => {
			runner!["epoch"] = 2;
			runner!["workerdProcess"] = replacement;
			runner!["healthy"] = true;
		});
		runner!["restart"] = restart;
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit");
		await flush();
		expect(oldProcess.kill).toHaveBeenCalledWith("SIGKILL");
		expect(restart).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(100);
		await flush();
		expect(restart).toHaveBeenCalledOnce();
		expect(replacement.kill).not.toHaveBeenCalled();
	});

	it("waits during recovery and invokes only the replacement listener", async () => {
		const { plugin, oldProcess, pendingFetches, pendingProbes } = await setup();
		vi.mocked(fetch).mockImplementation((input) => {
			const url = requestUrl(input);
			if (url.endsWith("/__ready")) {
				return new Promise<Response>((resolve) => {
					pendingProbes.push(() => resolve(new Response("", { status: 503 })));
				});
			}
			if (url.includes(":4100/")) {
				return new Promise<Response>((resolve) => {
					pendingFetches.push(() => resolve(new Response('{"ok":true}')));
				});
			}
			return Promise.resolve(new Response('{"ok":true}'));
		});
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
		expect(oldProcess.kill).not.toHaveBeenCalled();
		expect(pendingProbes).toHaveLength(1);

		let replacementSettled = false;
		const replacementCall = plugin.invokeRoute("ping", {}, REQUEST).finally(() => {
			replacementSettled = true;
		});
		await flush();
		expect(replacementSettled).toBe(false);
		expect(pendingProbes).toHaveLength(1);
		expect(pendingFetches).toHaveLength(1);

		pendingProbes.shift()!();
		await flush();
		expect(oldProcess.kill).toHaveBeenCalledWith("SIGKILL");
		expect(replacementSettled).toBe(false);

		await vi.advanceTimersByTimeAsync(500);
		expect(replacementSettled).toBe(false);
		releaseRestart();
		await replacementCall;
		expect(replacementSettled).toBe(true);
		expect(pendingFetches).toHaveLength(1);
		expect(
			vi.mocked(fetch).mock.calls.filter(([url]) => !requestUrl(url).endsWith("/__ready")),
		).toHaveLength(2);
		pendingFetches.forEach((settle) => settle());
	});

	it.each<[string, (current: WorkerdSandboxRunner) => void]>([
		[
			"the epoch changes",
			(current: WorkerdSandboxRunner) => {
				current["epoch"] = 2;
			},
		],
		[
			"the process handle is replaced",
			(current: WorkerdSandboxRunner) => {
				current["workerdProcess"] = fakeProcess();
			},
		],
		[
			"the process handle is cleared",
			(current: WorkerdSandboxRunner) => {
				current["workerdProcess"] = null;
			},
		],
		[
			"shutdown begins",
			(current: WorkerdSandboxRunner) => {
				current["shuttingDown"] = true;
			},
		],
	])("does not kill workerd when %s during the probe", async (_, changeState) => {
		const { plugin, oldProcess, pendingFetches, pendingProbes } = await setup();
		vi.mocked(fetch).mockImplementation((input) => {
			const url = requestUrl(input);
			if (url.endsWith("/__ready")) {
				return new Promise<Response>((resolve) => {
					pendingProbes.push(() => resolve(new Response("", { status: 503 })));
				});
			}
			return new Promise<Response>((resolve) => {
				pendingFetches.push(() => resolve(new Response('{"ok":true}')));
			});
		});
		const restart = vi.fn(async () => {});
		runner!["restart"] = restart;
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit");
		await flush();
		expect(pendingProbes).toHaveLength(1);

		const probes = [...runner!["timeoutProbes"]];
		changeState(runner!);
		pendingProbes.shift()!();
		await Promise.all(probes);

		expect(oldProcess.kill).not.toHaveBeenCalled();
		if (runner!["workerdProcess"]) expect(runner!["workerdProcess"]!.kill).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
		pendingFetches.forEach((settle) => settle());
	});

	it("does not restart when the listener responds to the timeout probe", async () => {
		const { plugin, oldProcess, pendingFetches } = await setup();
		vi.mocked(fetch).mockImplementation((input) => {
			const url = requestUrl(input);
			if (url.endsWith("/__ready")) return Promise.resolve(new Response(""));
			return new Promise<Response>((resolve) => {
				pendingFetches.push(() => resolve(new Response('{"ok":true}')));
			});
		});
		const restart = vi.fn(async () => {});
		runner!["restart"] = restart;
		const invocation = plugin.invokeRoute("ping", {}, REQUEST);
		void invocation.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		await expect(invocation).rejects.toThrow("exceeded wall-time limit");
		await flush();

		expect(oldProcess.kill).not.toHaveBeenCalled();
		if (runner!["workerdProcess"]) expect(runner!["workerdProcess"]!.kill).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
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
		const shutdown = runner!.terminateAll();
		releaseRestart();
		await shutdown;
		expect(runner!["workerdProcess"]).toBeNull();
		expect(runner!["backingServer"]).toBeNull();
		pendingFetches.forEach((settle) => settle());
	});

	it("preserves the caller timeout if recovery throws", async () => {
		const { plugin, pendingFetches } = await setup();
		const recoveryError = new Error("cannot stop workerd");
		vi.spyOn(runner!, "recoverFromTimeout").mockRejectedValue(recoveryError);
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
