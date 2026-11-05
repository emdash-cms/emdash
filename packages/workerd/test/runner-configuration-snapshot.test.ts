import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import type { Database, PluginManifest } from "emdash";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as DatabaseDriver } from "../../core/src/db/node-sqlite-compat.js";
import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn() };
});

function manifest(version: string): PluginManifest {
	return {
		id: "policy-plugin",
		version,
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
	};
}

describe("workerd configuration readiness", () => {
	let runner: WorkerdSandboxRunner;
	let db: Kysely<Database>;

	afterEach(async () => {
		await runner?.terminateAll();
		await db?.destroy();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("propagates a failed startup and retries after the restart backoff", async () => {
		vi.useFakeTimers();
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: new DatabaseDriver(":memory:") }),
		});
		runner = new WorkerdSandboxRunner({ db });
		runner["scheduleEagerStart"] = () => {};
		const startupError = new Error("workerd failed to start");
		let starts = 0;
		runner["restart"] = async () => {
			if (++starts === 1) throw startupError;
		};

		await runner.load(manifest("1.0.0"), "export default {};");
		const results = await Promise.allSettled([runner.ensureRunning(), runner.ensureRunning()]);
		expect(results).toEqual([
			{ status: "rejected", reason: startupError },
			{ status: "rejected", reason: startupError },
		]);
		expect(starts).toBe(1);
		expect(runner["needsRestart"]).toBe(true);

		await runner.ensureRunning();
		expect(starts).toBe(1);

		await vi.advanceTimersByTimeAsync(1000);
		await runner.ensureRunning();
		expect(starts).toBe(2);
		expect(runner["needsRestart"]).toBe(false);
	});

	it("rejects a failed spawn without waiting for an exit event", async () => {
		runner = new WorkerdSandboxRunner({ db: null as never });
		runner["scheduleEagerStart"] = () => {};
		vi.mocked(spawn).mockImplementation(() => {
			const child = new ChildProcess();
			const control = new PassThrough();
			Object.defineProperty(child, "stdio", { value: [null, null, null, control] });
			queueMicrotask(() => {
				child.emit("error", new Error("spawn workerd ENOENT"));
				control.end();
				child.emit("close", -2, null);
			});
			return child;
		});
		await runner.load(manifest("1.0.0"), "export default {};");
		await expect(runner.ensureRunning()).rejects.toThrow("spawn workerd ENOENT");
		expect(runner.isHealthy()).toBe(false);
		expect(runner["workerdProcess"]).toBeNull();
	});

	it("probes only plugins included in each spawned configuration", async () => {
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: new DatabaseDriver(":memory:") }),
		});
		runner = new WorkerdSandboxRunner({ db });
		let runningPorts = new Set<number>();
		const configurations: number[][] = [];
		let spawnCount = 0;

		vi.mocked(spawn).mockImplementation((_command, args) => {
			if (!Array.isArray(args) || typeof args[1] !== "string") {
				throw new Error("Expected a workerd configuration path");
			}
			const config = readFileSync(args[1], "utf8");
			const socketNames = Array.from(
				config.matchAll(/name = "(socket-[^"]+)"/g),
				(match) => match[1],
			);
			const ports = socketNames.map((_name, index) => 41000 + ++spawnCount + index);
			runningPorts = new Set(ports);
			configurations.push(ports);
			if (configurations.length === 1) {
				void runner.load(manifest("2.0.0"), "export default {};");
			}

			const child = new ChildProcess();
			const control = new PassThrough();
			const stderr = new PassThrough();
			Object.defineProperty(child, "stdio", { value: [null, null, stderr, control] });
			Object.defineProperty(child, "stderr", { value: stderr });
			queueMicrotask(() => {
				for (const [index, name] of socketNames.entries()) {
					control.write(
						`${JSON.stringify({ event: "listen", socket: name, port: ports[index] })}\n`,
					);
				}
			});
			vi.spyOn(child, "kill").mockImplementation(() => {
				queueMicrotask(() => {
					child.exitCode = 0;
					child.emit("exit", 0, "SIGTERM");
				});
				return true;
			});
			return child;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input) => {
				const url = new URL(input instanceof Request ? input.url : input);
				const ready = runningPorts.has(Number(url.port));
				return new Response(ready ? "ok" : "unavailable", { status: ready ? 200 : 503 });
			}),
		);

		await runner.load(manifest("1.0.0"), "export default {};");
		await runner.ensureRunning();

		expect(configurations.map((ports) => ports.length)).toEqual([1, 2]);
		expect(runner.isHealthy()).toBe(true);
	});
});
