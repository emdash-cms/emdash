import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const syncScript = fileURLToPath(
	new URL("../../../scripts/sync-templates-repo.mjs", import.meta.url),
);
const templates = [
	"blog",
	"blog-cloudflare",
	"marketing",
	"marketing-cloudflare",
	"portfolio",
	"portfolio-cloudflare",
	"starter",
	"starter-cloudflare",
];

function write(root: string, path: string, content: string) {
	const filename = join(root, path);
	mkdirSync(dirname(filename), { recursive: true });
	writeFileSync(filename, content);
}

describe("standalone template sync", () => {
	let tempDir: string;
	let source: string;
	let target: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "emdash-template-sync-"));
		source = join(tempDir, "source");
		target = join(tempDir, "target");
		write(source, "package.json", JSON.stringify({ packageManager: "pnpm@11.9.0" }));
		write(source, "pnpm-workspace.yaml", "catalog:\n  astro: ^7.0.0\n");
		write(
			source,
			"packages/core/package.json",
			JSON.stringify({ name: "emdash", version: "0.41.0" }),
		);
		mkdirSync(join(source, "scripts"));
		cpSync(syncScript, join(source, "scripts/sync-templates-repo.mjs"));
		write(source, "templates/blank/src/pages/index.astro", "Internal development template");
		for (const template of templates) {
			write(source, `templates/${template}/src/pages/index.astro`, `Current ${template} page`);
			write(
				source,
				`templates/${template}/package.json`,
				JSON.stringify({ dependencies: { emdash: "workspace:*", astro: "catalog:" } }),
			);
		}
		write(target, "blank/package.json", JSON.stringify({ dependencies: { emdash: "^0.8.0" } }));
		write(target, "starter/README.md", "Standalone installation instructions");
		write(target, "unrelated/keep.txt", "Keep target-only content");
		execFileSync("git", ["init", "--quiet"], { cwd: target });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function sync() {
		return execFileSync(
			process.execPath,
			[join(source, "scripts/sync-templates-repo.mjs"), "--local", target, "--dry-run"],
			{ encoding: "utf8" },
		);
	}

	it.each([
		{ name: "LF", eol: "\n" },
		{ name: "CRLF", eol: "\r\n" },
	])("retires blank from the published repository with $name line endings", ({ eol }) => {
		const introduction = "# Templates\n\n### Starter\n\n[View template](./starter)\n";
		const retired = "\n---\n\n### Blank\n\nLegacy template.\n\n[View template](./blank)\n";
		const variants = "\n## Variants\n\nEach template (except blank) comes in two variants:\n";
		write(target, "README.md", (introduction + retired + variants).replaceAll("\n", eol));
		const workflow = [
			"name: CI",
			"jobs:",
			"  smoke-test:",
			"    strategy:",
			"      matrix:",
			"        template:",
			"          - blank",
			...templates.map((template) => `          - ${template}`),
			"    steps:",
			"      - run: pnpm build",
			"",
		].join(eol);
		write(target, ".github/workflows/ci.yml", workflow);
		execFileSync("git", ["add", "--all"], { cwd: target });

		sync();

		expect(existsSync(join(target, "blank"))).toBe(false);
		expect(readFileSync(join(target, "README.md"), "utf8")).toBe(
			(introduction + variants.replace(" (except blank)", "")).replaceAll("\n", eol),
		);
		expect(readFileSync(join(target, ".github/workflows/ci.yml"), "utf8")).toBe(
			workflow.replace(`          - blank${eol}`, ""),
		);
		for (const template of templates) {
			expect(readFileSync(join(target, template, "src/pages/index.astro"), "utf8")).toBe(
				`Current ${template} page`,
			);
			expect(
				JSON.parse(readFileSync(join(target, template, "package.json"), "utf8")),
			).toMatchObject({
				dependencies: { emdash: "^0.41.0", astro: "^7.0.0" },
			});
		}
		expect(readFileSync(join(source, "templates/blank/src/pages/index.astro"), "utf8")).toBe(
			"Internal development template",
		);
		expect(readFileSync(join(target, "starter/README.md"), "utf8")).toBe(
			"Standalone installation instructions",
		);
		expect(readFileSync(join(target, "unrelated/keep.txt"), "utf8")).toBe(
			"Keep target-only content",
		);

		execFileSync("git", ["add", "--all"], { cwd: target });
		expect(sync()).toContain("No changes to sync.");
	});

	it("preserves the next template section when blank is not the last section", () => {
		const following = "\n### Starter\n\n[View template](./starter)\n";
		write(
			target,
			"README.md",
			`# Templates\n\n### Blank\n\n[View template](./blank)\n${following}`,
		);

		sync();

		expect(readFileSync(join(target, "README.md"), "utf8")).toBe(`# Templates\n${following}`);
	});

	it("syncs a fresh target without repository-level documentation or a CI workflow", () => {
		sync();

		expect(existsSync(join(target, "blank"))).toBe(false);
		expect(existsSync(join(target, "starter/src/pages/index.astro"))).toBe(true);
		expect(existsSync(join(target, "README.md"))).toBe(false);
		expect(existsSync(join(target, ".github/workflows/ci.yml"))).toBe(false);
	});
});
