import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function writeExport(dir: string, transform: (xml: string) => string): string {
	const exportPath = join(dir, "export.xml");
	writeFileSync(exportPath, transform(readFileSync(FIXTURE, "utf8")));
	return exportPath;
}

const ATTACHMENT_ITEM_PATTERN = /<item>\s*<title>hero<\/title>[\s\S]*?<\/item>/;

function withSecondHeroAttachment(xml: string): string {
	const item = ATTACHMENT_ITEM_PATTERN.exec(xml)![0];
	const second = item
		.replace("<wp:post_id>100</wp:post_id>", "<wp:post_id>101</wp:post_id>")
		.replaceAll("2025/01/hero.jpg", "2025/02/hero.jpg");
	return xml.replace(item, `${item}\n${second}`);
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

	it("counts each failed entry and attachment once", () => {
		const exportPath = join(dir, "export.xml");
		writeFileSync(
			exportPath,
			readFileSync(FIXTURE, "utf8").replaceAll(
				"https://example.com/wp-content/uploads/2025/01/hero.jpg",
				"http://127.0.0.1/hero.jpg",
			),
		);
		runCli("import", "wordpress", exportPath, "-o", outputDir);
		const configPath = join(outputDir, "migration-config.json");
		const config = readJson(configPath) as { fields: Record<string, { type: string }> };
		config.fields.custom_field!.type = "date";
		writeFileSync(configPath, JSON.stringify(config));

		const result = runCli(
			"import",
			"wordpress",
			exportPath,
			"-o",
			outputDir,
			"--execute",
			"--json",
		);

		expect(result.status).toBe(1);
		const summary = JSON.parse(result.stdout) as {
			summary: { errors: number };
			errors: unknown[];
		};
		expect(summary.errors).toHaveLength(2);
		expect(summary.summary.errors).toBe(2);
		expect(readJson(join(outputDir, ".wp-migration-progress.json"))).toMatchObject({
			errors: [{ type: "post" }, { type: "media" }],
			stats: { errorCount: 2 },
		});
	});

	it("reports a failed attachment and points to --resume", () => {
		const exportPath = join(dir, "export.xml");
		writeFileSync(
			exportPath,
			readFileSync(FIXTURE, "utf8").replaceAll(
				"https://example.com/wp-content/uploads/2025/01/hero.jpg",
				"http://127.0.0.1/hero.jpg",
			),
		);
		runCli("import", "wordpress", exportPath, "-o", outputDir);

		const result = runCli("import", "wordpress", exportPath, "-o", outputDir, "--execute");
		const json = runCli("import", "wordpress", exportPath, "-o", outputDir, "--execute", "--json");

		expect(result.status).toBe(1);
		expect(result.output).toContain("Errors: 1");
		const { nextSteps } = JSON.parse(json.stdout) as { nextSteps: string[] };
		expect(nextSteps.join("\n")).toContain("--execute --resume");
	});

	it("keeps a crafted post type inside the output directory", () => {
		const exportPath = writeExport(dir, (xml) =>
			xml.replace(
				"<wp:post_type><![CDATA[page]]></wp:post_type>",
				"<wp:post_type><![CDATA[../escape]]></wp:post_type>",
			),
		);

		expect(runCli("import", "wordpress", exportPath, "-o", outputDir).status).toBe(0);
		const config = readJson(join(outputDir, "migration-config.json")) as {
			collections: Record<string, { collection: string }>;
		};
		expect(config.collections["../escape"]?.collection).toBe("escape");

		const result = runCli(
			"import",
			"wordpress",
			exportPath,
			"-o",
			outputDir,
			"--execute",
			"--skip-media",
		);
		expect(result.status).toBe(0);
		expect(existsSync(join(outputDir, "escape", "about.json"))).toBe(true);
		expect(existsSync(join(dir, "escape"))).toBe(false);
	});

	it("keeps an edited collection name inside the output directory", () => {
		runCli("import", "wordpress", FIXTURE, "-o", outputDir);
		const configPath = join(outputDir, "migration-config.json");
		const config = readJson(configPath) as { collections: Record<string, { collection: string }> };
		config.collections.page!.collection = "../escape";
		writeFileSync(configPath, JSON.stringify(config));

		const result = runCli(
			"import",
			"wordpress",
			FIXTURE,
			"-o",
			outputDir,
			"--execute",
			"--skip-media",
		);

		expect(result.status).toBe(0);
		expect(existsSync(join(outputDir, "escape", "about.json"))).toBe(true);
		expect(existsSync(join(dir, "escape"))).toBe(false);
	});

	it("refuses to overwrite a migration config unless --force is passed", () => {
		expect(runCli("import", "wordpress", FIXTURE, "-o", outputDir).status).toBe(0);
		const configPath = join(outputDir, "migration-config.json");
		writeFileSync(configPath, JSON.stringify({ edited: true }));

		const again = runCli("import", "wordpress", FIXTURE, "-o", outputDir);
		expect(again.status).toBe(1);
		expect(again.output).toContain("Migration config already exists");
		expect(readJson(configPath)).toEqual({ edited: true });

		const forced = runCli("import", "wordpress", FIXTURE, "-o", outputDir, "--force");
		expect(forced.status).toBe(0);
		expect(readJson(configPath)).toMatchObject({ site: { title: "Test Blog" } });
	});

	it("gives attachments that share a file name their own paths", () => {
		const exportPath = writeExport(dir, withSecondHeroAttachment);
		runCli("import", "wordpress", exportPath, "-o", outputDir);

		const result = runCli(
			"import",
			"wordpress",
			exportPath,
			"-o",
			outputDir,
			"--execute",
			"--dry-run",
			"--json",
		);

		expect(result.status).toBe(0);
		const { files } = JSON.parse(result.stdout) as { files: Array<{ path: string }> };
		expect(files.map((file) => file.path)).toEqual(
			expect.arrayContaining([
				join(outputDir, "media", "2025", "01", "hero.jpg"),
				join(outputDir, "media", "2025", "02", "hero.jpg"),
			]),
		);
	});

	it("downloads a recorded attachment again on --resume when its file is missing", () => {
		const exportPath = writeExport(dir, withSecondHeroAttachment);
		runCli("import", "wordpress", exportPath, "-o", outputDir);
		runCli("import", "wordpress", exportPath, "-o", outputDir, "--execute", "--skip-media");
		const progressPath = join(outputDir, ".wp-migration-progress.json");
		const progress = readJson(progressPath) as { downloadedMedia: number[] };
		progress.downloadedMedia = [100, 101];
		writeFileSync(progressPath, JSON.stringify(progress));
		mkdirSync(join(outputDir, "media", "2025", "01"), { recursive: true });
		writeFileSync(join(outputDir, "media", "2025", "01", "hero.jpg"), "");

		const result = runCli(
			"import",
			"wordpress",
			exportPath,
			"-o",
			outputDir,
			"--resume",
			"--dry-run",
			"--json",
		);

		expect(result.status).toBe(0);
		const { files, summary } = JSON.parse(result.stdout) as {
			files: Array<{ path: string }>;
			summary: { mediaSkipped: number };
		};
		const mediaFiles = files.filter((file) => file.path.startsWith(join(outputDir, "media")));
		expect(mediaFiles.map((file) => file.path)).toEqual([
			join(outputDir, "media", "2025", "02", "hero.jpg"),
		]);
		expect(summary.mediaSkipped).toBe(1);
	});

	it("clears an error from the progress file once --resume converts the entry", () => {
		runCli("import", "wordpress", FIXTURE, "-o", outputDir);
		const configPath = join(outputDir, "migration-config.json");
		const config = readJson(configPath) as { fields: Record<string, { type: string }> };
		config.fields.custom_field!.type = "date";
		writeFileSync(configPath, JSON.stringify(config));
		const progressPath = join(outputDir, ".wp-migration-progress.json");

		const failed = runCli(
			"import",
			"wordpress",
			FIXTURE,
			"-o",
			outputDir,
			"--execute",
			"--skip-media",
		);
		expect(failed.status).toBe(1);
		expect(readJson(progressPath)).toMatchObject({
			errors: [{ type: "post" }],
			stats: { errorCount: 1 },
		});

		config.fields.custom_field!.type = "string";
		writeFileSync(configPath, JSON.stringify(config));
		const resumed = runCli(
			"import",
			"wordpress",
			FIXTURE,
			"-o",
			outputDir,
			"--resume",
			"--skip-media",
		);

		expect(resumed.status).toBe(0);
		expect(readJson(progressPath)).toMatchObject({ errors: [], stats: { errorCount: 0 } });
	});

	it("keeps a future post scheduled", () => {
		const exportPath = writeExport(dir, (xml) =>
			xml
				.replace(
					"<wp:post_date_gmt><![CDATA[2025-01-18 09:00:00]]></wp:post_date_gmt>",
					"<wp:post_date_gmt><![CDATA[2099-01-18 09:00:00]]></wp:post_date_gmt>",
				)
				.replace(
					"<wp:status><![CDATA[draft]]></wp:status>",
					"<wp:status><![CDATA[future]]></wp:status>",
				),
		);
		runCli("import", "wordpress", exportPath, "-o", outputDir);

		const result = runCli(
			"import",
			"wordpress",
			exportPath,
			"-o",
			outputDir,
			"--execute",
			"--skip-media",
		);

		expect(result.status).toBe(0);
		expect(readJson(join(outputDir, "posts", "work-in-progress.json"))).toMatchObject({
			status: "scheduled",
			scheduledAt: "2099-01-18T09:00:00.000Z",
			publishedAt: null,
		});
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
