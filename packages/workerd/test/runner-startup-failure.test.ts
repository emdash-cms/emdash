import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import type { PluginManifest } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn() };
});

const MANIFEST: PluginManifest = {
	id: "startup-failure-plugin",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [],
	admin: {},
};

const REQUEST = { method: "GET", url: "/ping", headers: {} };
const DIAGNOSTIC = "bind(): Address already in use (/tmp/private-workerd/workerd.capnp)";

function failedChild({ spawnError = false }: { spawnError?: boolean } = {}): ChildProcess {
	const child = new ChildProcess();
	const stderr = new PassThrough();
	const control = new PassThrough();
	Object.defineProperty(child, "stdio", { value: [null, null, stderr, control] });
	Object.defineProperty(child, "stderr", { value: stderr });
	Object.defineProperty(child, "stdout", { value: null });
	vi.spyOn(child, "kill").mockReturnValue(true);
	process.nextTick(() => {
		if (spawnError) {
			child.emit("error", Object.assign(new Error("spawn workerd ENOENT"), { code: "ENOENT" }));
			control.end();
			return;
		}
		stderr.write(DIAGNOSTIC);
		child.exitCode = 1;
		child.emit("exit", 1, null);
		control.end();
		child.emit("close", 1, null);
	});
	return child;
}

describe("workerd startup failures", () => {
	let runner: WorkerdSandboxRunner | undefined;

	afterEach(async () => {
		await runner?.terminateAll();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function setup(options?: { spawnError?: boolean }) {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		runner = new WorkerdSandboxRunner({ db: null as never });
		runner["scheduleEagerStart"] = () => {};
		vi.mocked(spawn)
			.mockReset()
			.mockImplementation(() => failedChild(options));
		const plugin = await runner.load(MANIFEST, "export default {};");
		return plugin;
	}

	async function invoke(
		plugin: Awaited<ReturnType<WorkerdSandboxRunner["load"]>>,
		kind: "hook" | "route",
	) {
		if (kind === "hook") return plugin.invokeHook("plugin:activate", {});
		return plugin.invokeRoute("ping", {}, REQUEST);
	}

	it.each(["hook", "route"] as const)(
		"sanitizes the initial %s startup failure and logs the raw diagnostic",
		async (kind) => {
			const plugin = await setup();
			const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const fetchSpy = vi.spyOn(globalThis, "fetch");

			const error = await invoke(plugin, kind).catch((failure: unknown) => failure);

			expect(error).toMatchObject({ name: "SandboxUnavailableError" });
			expect(error).toHaveProperty("message", expect.stringContaining("workerd failed to start"));
			expect(error).not.toHaveProperty("message", expect.stringContaining("private-workerd"));
			expect(error).not.toHaveProperty(
				"message",
				expect.stringContaining("Address already in use"),
			);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(DIAGNOSTIC);
		},
	);

	it("shares the first failed startup and throttles concurrent hooks during backoff", async () => {
		const plugin = await setup();
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const startupLogs = () =>
			errorLog.mock.calls.filter(([message]) => message === "[emdash:workerd] startup failed:");
		const first = await Promise.all([
			invoke(plugin, "hook").catch((error: unknown) => error),
			invoke(plugin, "hook").catch((error: unknown) => error),
			invoke(plugin, "route").catch((error: unknown) => error),
		]);
		expect(spawn).toHaveBeenCalledOnce();
		const duringBackoff = await Promise.all(
			Array.from({ length: 5 }, () => invoke(plugin, "hook").catch((error: unknown) => error)),
		);
		expect(spawn).toHaveBeenCalledOnce();
		expect(startupLogs()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(999);
		await invoke(plugin, "route").catch(() => {});
		expect(spawn).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await invoke(plugin, "hook").catch(() => {});
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(startupLogs()).toHaveLength(2);
		for (const error of [...first, ...duringBackoff]) {
			expect(error).toMatchObject({ name: "SandboxUnavailableError" });
		}
	});

	it("stops spawning after the crash budget is spent, including after the window elapses", async () => {
		const plugin = await setup();
		for (const delay of [0, 1_000, 2_000, 4_000, 8_000, 16_000]) {
			if (delay) await vi.advanceTimersByTimeAsync(delay);
			await invoke(plugin, "hook").catch(() => {});
		}
		expect(spawn).toHaveBeenCalledTimes(6);
		expect(runner?.["gaveUp"]).toBe(true);
		for (let i = 0; i < 5; i++) {
			await invoke(plugin, "hook").catch(() => {});
			await invoke(plugin, "route").catch(() => {});
		}
		expect(spawn).toHaveBeenCalledTimes(6);

		await vi.advanceTimersByTimeAsync(60_001);
		const failures = await Promise.all([
			invoke(plugin, "hook").catch((error: unknown) => error),
			invoke(plugin, "route").catch((error: unknown) => error),
		]);
		expect(failures.every((error) => (error as Error).name === "SandboxUnavailableError")).toBe(
			true,
		);
		expect(spawn).toHaveBeenCalledTimes(6);
	});

	it("throttles repeated spawn errors without an exit event", async () => {
		const plugin = await setup({ spawnError: true });
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(invoke(plugin, "hook")).rejects.toMatchObject({
			name: "SandboxUnavailableError",
		});
		await expect(invoke(plugin, "hook")).rejects.toMatchObject({
			name: "SandboxUnavailableError",
		});
		expect(spawn).toHaveBeenCalledOnce();
		expect(errorLog).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(invoke(plugin, "route")).rejects.toMatchObject({
			name: "SandboxUnavailableError",
		});
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(errorLog).toHaveBeenLastCalledWith(
			"[emdash:workerd] startup failed:",
			expect.objectContaining({ message: expect.stringContaining("ENOENT") }),
		);
		expect(errorLog).toHaveBeenCalledTimes(2);
	});
});
