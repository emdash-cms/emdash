import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");
const CLI_ENV = { ...process.env, NODE_ENV: "production", TEST: "", NO_COLOR: "1" };
const PACKAGE_JSON = resolve(import.meta.dirname, "../../../package.json");
const FIXTURE = resolve(import.meta.dirname, "../wordpress-import/fixtures/sample-export.xml");

function runCli(...args: string[]) {
	const result = spawnSync("node", [CLI_BIN, ...args], { encoding: "utf8", env: CLI_ENV });
	return {
		status: result.status,
		stdout: result.stdout,
		output: `${result.stdout}${result.stderr}`,
	};
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("CLI version", () => {
	it("reports the package version", () => {
		const { version } = readJson(PACKAGE_JSON) as { version: string };

		expect(runCli("--version").stdout.trim()).toBe(version);
		expect(runCli("--help").output).toContain(`(emdash v${version})`);
	});
});

describe("emdash import wordpress", () => {
	let dir: string;
	let outputDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "emdash-wp-import-"));
		outputDir = join(dir, "out");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is listed in the CLI help", () => {
		expect(runCli("--help").output).toMatch(/^\s+import\s+/m);
	});

	it("writes nothing in prepare dry-run mode", () => {
		const result = runCli("import", "wordpress", FIXTURE, "-o", outputDir, "--dry-run");

		expect(result.status).toBe(0);
		expect(result.output).toContain("post → posts (3 items) [enabled]");
		expect(existsSync(outputDir)).toBe(false);
	});

	it("prepares a config, then converts content with --execute", () => {
		expect(runCli("import", "wordpress", FIXTURE, "-o", outputDir).status).toBe(0);
		expect(existsSync(join(outputDir, "migration-config.json"))).toBe(true);

		const dryRun = runCli(
			"import",
			"wordpress",
			FIXTURE,
			"-o",
			outputDir,
			"--execute",
			"--dry-run",
			"--skip-media",
		);
		expect(dryRun.status).toBe(0);
		expect(dryRun.output).toContain("Would import: 5");
		expect(existsSync(join(outputDir, "posts"))).toBe(false);

		const execute = runCli(
			"import",
			"wordpress",
			FIXTURE,
			"-o",
			outputDir,
			"--execute",
			"--skip-media",
		);
		expect(execute.status).toBe(0);
		expect(readJson(join(outputDir, "posts", "hello-world.json"))).toMatchObject({
			title: "Hello World",
			status: "published",
		});
		expect(readJson(join(outputDir, "pages", "about.json"))).toMatchObject({ title: "About Us" });
		expect(readJson(join(outputDir, ".wp-migration-progress.json"))).toMatchObject({
			importedPosts: [1, 2, 3, 10, 11],
		});
	});

	it("prints next-step commands that keep a custom output dir and config", () => {
		const configPath = join(dir, "custom config.json");
		const prepare = runCli("import", "wordpress", FIXTURE, "-o", outputDir, "--config", configPath);

		expect(prepare.status).toBe(0);
		expect(prepare.output).toContain(
			`emdash import wordpress ${FIXTURE} -o ${outputDir} --config '${configPath}' --execute`,
		);
	});

	it("resumes an interrupted run without dropping earlier redirects", () => {
		runCli("import", "wordpress", FIXTURE, "-o", outputDir);
		runCli("import", "wordpress", FIXTURE, "-o", outputDir, "--execute", "--skip-media");

		const progressPath = join(outputDir, ".wp-migration-progress.json");
		const progress = readJson(progressPath) as { importedPosts: number[] };
		progress.importedPosts = [1, 2, 3];
		writeFileSync(progressPath, JSON.stringify(progress));
		rmSync(join(outputDir, "pages"), { recursive: true });
		const redirectsBefore = readJson(join(outputDir, "_redirects.json"));

		const resume = runCli(
			"import",
			"wordpress",
			FIXTURE,
			"-o",
			outputDir,
			"--resume",
			"--skip-media",
		);

		expect(resume.status).toBe(0);
		expect(resume.output).toContain("Imported: 2");
		expect(resume.output).toContain("Resumed (skipped): 3");
		expect(existsSync(join(outputDir, "pages", "about.json"))).toBe(true);
		expect(readJson(join(outputDir, "_redirects.json"))).toEqual(redirectsBefore);
	});

	it("fails when the export file does not exist", () => {
		const result = runCli("import", "wordpress", join(dir, "missing.xml"), "-o", outputDir);

		expect(result.status).toBe(1);
		expect(result.output).toContain("Export file not found");
	});

	it("rejects --prepare combined with --resume", () => {
		const result = runCli("import", "wordpress", FIXTURE, "--prepare", "--resume");

		expect(result.status).toBe(1);
		expect(result.output).toContain("--prepare cannot be combined");
	});
});
