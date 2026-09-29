import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ensureBuilt } from "../server.js";

const execAsync = promisify(execFile);
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const FIXTURE_DIR = resolve(import.meta.dirname, "../fixture");
const SERVERS_BASE = resolve(import.meta.dirname, "../.servers");
const DONOR_NODE_MODULES = resolve(WORKSPACE_ROOT, "demos/simple/node_modules");
const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");
const SMOKE_FONT_PROVIDER_IMPORT = pathToFileURL(
	resolve(import.meta.dirname, "smoke-font-provider.mjs"),
).href;

function nodeOptionsWithSmokeFontProvider(): string {
	return [process.env.NODE_OPTIONS, `--import=${SMOKE_FONT_PROVIDER_IMPORT}`]
		.filter(Boolean)
		.join(" ");
}

describe("SQLite static prerender", () => {
	let workDir: string | undefined;

	afterEach(() => {
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	async function buildFixture(env: Record<string, string> = {}): Promise<string> {
		await ensureBuilt();
		mkdirSync(SERVERS_BASE, { recursive: true });
		const dir = mkdtempSync(join(SERVERS_BASE, "prerender-"));
		workDir = dir;
		cpSync(FIXTURE_DIR, dir, {
			recursive: true,
			filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
		});
		symlinkSync(DONOR_NODE_MODULES, join(dir, "node_modules"));

		const databasePath = join(dir, "prerender.db");
		await execAsync(process.execPath, [CLI_BIN, "init", "--database", databasePath, "--cwd", dir]);
		await execAsync(process.execPath, [CLI_BIN, "seed", "--database", databasePath, "--cwd", dir]);

		const astro = join(dir, "node_modules", ".bin", "astro");
		await execAsync(astro, ["build"], {
			cwd: dir,
			timeout: 90_000,
			env: {
				...process.env,
				CI: "true",
				NODE_OPTIONS: nodeOptionsWithSmokeFontProvider(),
				EMDASH_TEST_DB: `file:${databasePath}`,
				EMDASH_TEST_UPLOADS: join(dir, "uploads"),
				EMDASH_TEST_VITE_CACHE: join(dir, ".vite-cache"),
				...env,
			},
		});
		return dir;
	}

	it("builds a page that queries a live collection", { timeout: 120_000 }, async () => {
		const dir = await buildFixture();

		expect(existsSync(join(dir, "dist/client/prerender-check/index.html"))).toBe(true);
	});

	it('keeps EmDash routes on demand with output: "static"', { timeout: 120_000 }, async () => {
		const dir = await buildFixture({ EMDASH_TEST_OUTPUT: "static" });

		expect(existsSync(join(dir, "dist/client/index.html"))).toBe(true);
		expect(existsSync(join(dir, "dist/client/_emdash"))).toBe(false);
		expect(existsSync(join(dir, "dist/client/sitemap.xml"))).toBe(false);
		expect(existsSync(join(dir, "dist/client/robots.txt"))).toBe(false);
		expect(existsSync(join(dir, "dist/client/.well-known"))).toBe(false);
	});
});
