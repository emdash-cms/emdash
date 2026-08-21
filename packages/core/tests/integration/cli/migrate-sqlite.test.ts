import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATE_EXIT_CODES } from "../../../src/cli/commands/migrate.js";
import type { CoreMigrationIdentity } from "../../../src/migrations/identity.js";
import { ensureBuilt } from "../server.js";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");
const CORE_PACKAGE = resolve(import.meta.dirname, "../../..");

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

describe("built migrate CLI with SQLite", () => {
	let projectRoot: string;
	let identity: CoreMigrationIdentity;

	beforeAll(async () => {
		await ensureBuilt();
		projectRoot = await mkdtemp(join(tmpdir(), "emdash-migrate-cli-"));
		await mkdir(join(projectRoot, "node_modules"), { recursive: true });
		await mkdir(join(projectRoot, ".emdash"), { recursive: true });
		await writeFile(join(projectRoot, "package.json"), '{"type":"module"}');
		await symlink(CORE_PACKAGE, join(projectRoot, "node_modules", "emdash"), "dir");

		const migrationsModule: unknown = await import(
			pathToFileURL(resolve(CORE_PACKAGE, "dist/migrations/index.mjs")).href
		);
		if (
			typeof migrationsModule !== "object" ||
			migrationsModule === null ||
			!("getCoreMigrationIdentity" in migrationsModule) ||
			typeof migrationsModule.getCoreMigrationIdentity !== "function"
		) {
			throw new Error("Built migration identity export is missing");
		}
		identity = await migrationsModule.getCoreMigrationIdentity();
		await writeFile(
			join(projectRoot, ".emdash", "migrations.json"),
			JSON.stringify({
				schemaVersion: 1,
				emdashVersion: identity.emdashVersion,
				migrationSet: { names: identity.names, fingerprint: identity.fingerprint },
				i18n: null,
				database: {
					type: "sqlite",
					executorEntrypoint: "emdash/db/sqlite-migrations",
					executorConfig: { url: "file:./data.db" },
				},
			}),
		);
	});

	afterAll(async () => {
		if (projectRoot) await rm(projectRoot, { force: true, recursive: true });
	});

	function run(...args: string[]): CliResult {
		const result = spawnSync("node", [CLI_BIN, "migrate", ...args], {
			cwd: projectRoot,
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
		});
		if (result.error) throw result.error;
		return { code: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	it("checks, applies once with a target fingerprint, and becomes idempotent", () => {
		const initial = run("--status", "--json");
		expect(initial.code).toBe(0);
		const initialReport: unknown = JSON.parse(initial.stdout);
		if (
			typeof initialReport !== "object" ||
			initialReport === null ||
			!("target" in initialReport) ||
			typeof initialReport.target !== "object" ||
			initialReport.target === null ||
			!("fingerprint" in initialReport.target) ||
			typeof initialReport.target.fingerprint !== "string"
		) {
			throw new Error("CLI returned an invalid target report");
		}
		expect(initial.stderr).toContain(initialReport.target.fingerprint);

		const applied = run(
			"--json",
			"--expected-target-fingerprint",
			initialReport.target.fingerprint,
		);
		expect(applied.code).toBe(0);
		const appliedReport: unknown = JSON.parse(applied.stdout);
		if (
			typeof appliedReport !== "object" ||
			appliedReport === null ||
			!("executed" in appliedReport) ||
			!Array.isArray(appliedReport.executed)
		) {
			throw new Error("CLI returned an invalid apply report");
		}
		expect(appliedReport.executed.length).toBeGreaterThan(0);
		expect(appliedReport).toMatchObject({ pending: [] });

		const check = run("--check", "--json");
		expect(check.code).toBe(0);
		expect(JSON.parse(check.stdout)).toMatchObject({ pending: [], unknownApplied: [] });
	});

	it("bounds real signal cleanup without waiting for in-flight execution", async () => {
		const executorPackage = join(projectRoot, "node_modules", "emdash-test-migration-executor");
		const markerPath = join(projectRoot, "disposed.txt");
		await mkdir(executorPackage, { recursive: true });
		await writeFile(
			join(executorPackage, "package.json"),
			'{"name":"emdash-test-migration-executor","type":"module","exports":"./index.js"}',
		);
		await writeFile(
			join(executorPackage, "index.js"),
			`import { writeFile } from "node:fs/promises";
			let timer;
			export function createMigrationExecutor(config) {
				return {
					target: Object.freeze({ kind: "test", label: "signal-target", fingerprint: "${"d".repeat(64)}" }),
					execute() { return new Promise(() => { timer = setInterval(() => {}, 1_000); process.stderr.write("executor ready\\n"); }); },
				async dispose() { clearInterval(timer); await writeFile(config.markerPath, "disposed"); }
				};
			}`,
		);
		await writeFile(
			join(projectRoot, "signal-migrations.json"),
			JSON.stringify({
				schemaVersion: 1,
				emdashVersion: identity.emdashVersion,
				migrationSet: { names: identity.names, fingerprint: identity.fingerprint },
				i18n: null,
				database: {
					type: "sqlite",
					executorEntrypoint: "emdash-test-migration-executor",
					executorConfig: { markerPath },
				},
			}),
		);

		const child = spawn(
			"node",
			[CLI_BIN, "migrate", "--status", "--manifest", "signal-migrations.json"],
			{
				cwd: projectRoot,
				env: { ...process.env, NO_COLOR: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child.stderr.setEncoding("utf8");
		let stderr = "";
		await new Promise<void>((resolveTarget, rejectTarget) => {
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
				if (stderr.includes("executor ready")) resolveTarget();
			});
			child.once("error", rejectTarget);
			child.once("exit", (code, signal) =>
				rejectTarget(new Error(`CLI exited before signal: ${code ?? signal}`)),
			);
		});
		expect(child.kill("SIGTERM")).toBe(true);
		const [code, signal] = await once(child, "exit");

		expect(code).toBe(MIGRATE_EXIT_CODES.interrupted);
		expect(signal).toBeNull();
		expect(await readFile(markerPath, "utf8")).toBe("disposed");
	}, 15_000);
});
