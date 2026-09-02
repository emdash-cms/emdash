import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ensureBuilt } from "../server.js";

const execAsync = promisify(execFile);
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const FIXTURE_DIR = resolve(import.meta.dirname, "../fixture");
const SERVERS_BASE = resolve(import.meta.dirname, "../.servers");
const DONOR_NODE_MODULES = resolve(WORKSPACE_ROOT, "demos/simple/node_modules");
const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");

describe("SQLite static prerender", () => {
	let workDir: string | undefined;

	afterEach(() => {
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("builds a page that queries a live collection", { timeout: 120_000 }, async () => {
		await ensureBuilt();
		mkdirSync(SERVERS_BASE, { recursive: true });
		workDir = mkdtempSync(join(SERVERS_BASE, "prerender-"));
		cpSync(FIXTURE_DIR, workDir, {
			recursive: true,
			filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
		});
		symlinkSync(DONOR_NODE_MODULES, join(workDir, "node_modules"));

		const databasePath = join(workDir, "prerender.db");
		await execAsync(process.execPath, [
			CLI_BIN,
			"init",
			"--database",
			databasePath,
			"--cwd",
			workDir,
		]);
		await execAsync(process.execPath, [
			CLI_BIN,
			"seed",
			"--database",
			databasePath,
			"--cwd",
			workDir,
		]);

		const astro = join(workDir, "node_modules", ".bin", "astro");
		await execAsync(astro, ["build"], {
			cwd: workDir,
			timeout: 90_000,
			env: {
				...process.env,
				CI: "true",
				EMDASH_TEST_DB: `file:${databasePath}`,
				EMDASH_TEST_UPLOADS: join(workDir, "uploads"),
				EMDASH_TEST_VITE_CACHE: join(workDir, ".vite-cache"),
			},
		});

		expect(existsSync(join(workDir, "dist/client/prerender-check/index.html"))).toBe(true);
	});
});
