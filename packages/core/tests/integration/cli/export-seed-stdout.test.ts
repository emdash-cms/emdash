import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { MIGRATION_NAMES, runMigrations } from "../../../src/database/migrations/runner.js";
import { ensureBuilt } from "../server.js";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Regression for #2774 (1): `export-seed` writes the seed document to stdout
 * with `console.log`, but also announced the resolved database path there via
 * `consola.info`, and an internal `orderBy(array)` call made kysely print a
 * deprecation notice to the same stream. `emdash export-seed > backup.json`
 * therefore produced a file that is not JSON while the command exited 0 with
 * an empty stderr, so the corruption only surfaced at restore time.
 *
 * Runs the built binary rather than calling `run()` in-process: the stream a
 * value lands on is the thing under test, and only a real process has real
 * streams to separate.
 */
describe("export-seed stdout is the seed document alone (#2774)", () => {
	let projectRoot: string;
	let dbPath: string;

	beforeAll(async () => {
		await ensureBuilt();
		projectRoot = await mkdtemp(join(tmpdir(), "emdash-export-seed-cli-"));
		dbPath = join(projectRoot, "data.db");

		// Migrate up front so the export runs against a ready database. The
		// command migrating its own source is a separate defect in the same
		// issue; this test must not depend on it either way.
		const db = createDatabase({ url: `file:${dbPath}` });
		await runMigrations(db);
		await db.destroy();
	});

	afterAll(async () => {
		if (projectRoot) await rm(projectRoot, { force: true, recursive: true });
	});

	function run(...args: string[]): CliResult {
		return runDatabase(dbPath, ...args);
	}

	function runDatabase(databasePath: string, ...args: string[]): CliResult {
		const result = spawnSync("node", [CLI_BIN, "export-seed", "-d", databasePath, ...args], {
			cwd: projectRoot,
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
		});
		if (result.error) throw result.error;
		return { code: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	it("redirects to a file that parses as JSON", () => {
		const result = run("--with-content", "all");

		expect(result.code).toBe(0);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	it("reports the database path on stderr, not stdout", () => {
		const result = run();

		expect(result.stderr).toContain(dbPath);
		expect(result.stdout).not.toContain(dbPath);
	});

	it("keeps kysely's orderBy deprecation notice off stdout", () => {
		const result = run();

		expect(result.stdout).not.toContain("deprecated");
	});

	it("rejects an unmigrated database without changing it", async () => {
		const emptyPath = join(projectRoot, "empty.db");
		await writeFile(emptyPath, "");

		const result = runDatabase(emptyPath);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Run `emdash migrate` before exporting it.");
		expect(await readFile(emptyPath)).toHaveLength(0);
	});

	it("rejects an outdated database without applying its pending migration", async () => {
		const outdatedPath = join(projectRoot, "outdated.db");
		const outdatedDb = createDatabase({ url: `file:${outdatedPath}` });
		await runMigrations(outdatedDb);
		const pending = MIGRATION_NAMES.at(-1);
		if (!pending) throw new Error("Expected at least one registered migration");
		await outdatedDb.deleteFrom("_emdash_migrations").where("name", "=", pending).execute();
		await outdatedDb.destroy();
		const before = await readFile(outdatedPath);

		const result = runDatabase(outdatedPath);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("1 pending migration");
		expect(await readFile(outdatedPath)).toEqual(before);
	});

	it("rejects a database migrated by a newer EmDash version", async () => {
		const newerPath = join(projectRoot, "newer.db");
		const newerDb = createDatabase({ url: `file:${newerPath}` });
		await runMigrations(newerDb);
		await newerDb
			.insertInto("_emdash_migrations")
			.values({ name: "999_future", timestamp: new Date().toISOString() })
			.execute();
		await newerDb.destroy();
		const before = await readFile(newerPath);

		const result = runDatabase(newerPath);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Upgrade EmDash before exporting it.");
		expect(await readFile(newerPath)).toEqual(before);
	});
});
