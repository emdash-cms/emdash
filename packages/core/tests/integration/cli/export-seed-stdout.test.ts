import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
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
		const result = spawnSync("node", [CLI_BIN, "export-seed", "-d", dbPath, ...args], {
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
});
