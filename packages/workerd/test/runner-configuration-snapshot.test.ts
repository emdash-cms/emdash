import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import DatabaseDriver from "better-sqlite3";
import type { Database, PluginManifest } from "emdash";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

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
	});

	it("probes only plugins included in each spawned configuration", async () => {
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: new DatabaseDriver(":memory:") }),
		});
		runner = new WorkerdSandboxRunner({ db });
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let runningPorts = new Set<number>();
		const configurations: number[][] = [];

		vi.mocked(spawn).mockImplementation((_command, args) => {
			if (!Array.isArray(args) || typeof args[1] !== "string") {
				throw new Error("Expected a workerd configuration path");
			}
			const config = readFileSync(args[1], "utf8");
			const ports = Array.from(
				config.matchAll(/name = "socket-[^"]+", address = "127\.0\.0\.1:(\d+)"/g),
				(match) => Number(match[1]),
			);
			runningPorts = new Set(ports);
			configurations.push(ports);
			if (configurations.length === 1) {
				void runner.load(manifest("2.0.0"), "export default {};");
			}

			const child = new ChildProcess();
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
				// Advance the readiness deadline when no configured listener can answer.
				if (!ready) now += 10_000;
				return new Response(ready ? "ok" : "unavailable", { status: ready ? 200 : 503 });
			}),
		);

		await runner.load(manifest("1.0.0"), "export default {};");
		await runner.ensureRunning();

		expect(configurations.map((ports) => ports.length)).toEqual([1, 2]);
		expect(runner.isHealthy()).toBe(true);
	});
});
