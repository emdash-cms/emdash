import { describe, expect, it } from "vitest";

import { elideLargeDiffSections } from "../.flue/lib/diff-budget.js";

function fileSection(path: string, lines: number, line = "+const x = 1;"): string {
	return [
		`diff --git a/${path} b/${path}`,
		"index 0000000..1111111 100644",
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -0,0 +1 @@",
		...Array.from({ length: lines }).fill(line).map(String),
		"",
	].join("\n");
}

describe("elideLargeDiffSections", () => {
	it("returns a small diff unchanged", () => {
		const diff = fileSection("src/a.ts", 10) + fileSection("src/b.ts", 20);
		expect(elideLargeDiffSections(diff)).toBe(diff);
	});

	it.each([
		"worker-configuration.d.ts",
		"infra/emdash-bot/worker-configuration.d.ts",
		"packages/plugins/example/generated/worker-configuration.d.ts",
	])("always omits generated Worker types at %s", (path) => {
		const generated = fileSection(path, 2, "+declare const generatedSecret: string;");
		const source = fileSection("src/a.ts", 2);
		const out = elideLargeDiffSections(generated + source);

		expect(out).toContain(`diff --git a/${path} b/${path}`);
		expect(out).toContain("generated Worker types omitted from model review context");
		expect(out).not.toContain("generatedSecret");
		expect(out).toContain(source);
	});

	it("does not omit a similarly named source file", () => {
		const diff = fileSection("src/worker-configuration.d.ts.template", 2);
		expect(elideLargeDiffSections(diff)).toBe(diff);
	});

	it("reports a compiled release Action change without exposing its diff", () => {
		const compiled = fileSection(
			"apps/release-action/dist/index.js",
			2,
			"+const compiledSecret = 'never return this';",
		);
		const source = fileSection("apps/release-action/src/index.ts", 2);
		const out = elideLargeDiffSections(compiled + source);
		const compiledMarker = [
			"diff --git a/apps/release-action/dist/index.js b/apps/release-action/dist/index.js",
			"(compiled release-action artifact changed; contents omitted from model review context)",
			"",
		].join("\n");

		expect(out).toBe(compiledMarker + source);
		expect(out).not.toContain("compiledSecret");
	});

	it.each([
		"diff --git a/apps/release-action/dist/index.js b/apps/release-action/dist/renamed.js",
		"diff --git a/apps/release-action/dist/old.js b/apps/release-action/dist/index.js",
	])("omits compiled content when a rename touches the artifact: %s", (header) => {
		const diff = [header, "similarity index 99%", "renamed bundle content", ""].join("\n");

		expect(elideLargeDiffSections(diff)).toBe(
			`${header}\n(compiled release-action artifact changed; contents omitted from model review context)\n`,
		);
	});

	it.each([
		"apps/release-action/dist/index.js.map",
		"apps/release-action/dist/index.jsx",
		"apps/release-action/dist/nested/index.js",
		"apps/release-action-copy/dist/index.js",
	])("does not omit the similarly named release Action path %s", (path) => {
		const diff = fileSection(path, 2);
		expect(elideLargeDiffSections(diff)).toBe(diff);
	});

	it("elides a section over the per-file budget, keeping its header", () => {
		const big = fileSection("types.d.ts", 2_000);
		const small = fileSection("src/a.ts", 5);
		const out = elideLargeDiffSections(small + big, { perFileBytes: 1_000 });
		expect(out).toContain(small);
		expect(out).toContain("diff --git a/types.d.ts b/types.d.ts");
		expect(out).toContain("+++ b/types.d.ts");
		expect(out).toMatch(/diff content elided: \d+ lines/);
		expect(out).not.toContain("+const x = 1;\n+const x = 1;\n".repeat(50));
	});

	it("elides largest sections first until under the total budget", () => {
		const a = fileSection("a.ts", 30);
		const b = fileSection("b.ts", 60);
		const c = fileSection("c.ts", 10);
		const out = elideLargeDiffSections(a + b + c, {
			perFileBytes: 10_000,
			totalBytes: a.length + c.length + 400,
		});
		expect(out).toContain("diff content elided");
		expect(out).toContain(a);
		expect(out).toContain(c);
		expect(out).not.toContain(b);
	});

	it("applies budgets to UTF-8 bytes rather than JavaScript string length", () => {
		const unicode = fileSection("src/unicode.ts", 100, "+const value = 'é';");
		const budgetBetweenCodeUnitsAndBytes = unicode.length + 1;
		const out = elideLargeDiffSections(unicode, {
			perFileBytes: budgetBetweenCodeUnitsAndBytes,
			totalBytes: 100_000,
		});

		expect(out).toContain("diff content elided");
	});

	it("skips an unreducible headerless section instead of looping on it", () => {
		const headerless = `diff --git a/blob.bin b/blob.bin\nBinary files differ\n${"x\n".repeat(1_000)}`;
		const small = fileSection("src/a.ts", 5);
		const out = elideLargeDiffSections(small + headerless, {
			perFileBytes: 500,
			totalBytes: 600,
		});
		expect(out).toContain("Binary files differ");
		expect(out).toContain("+++ b/src/a.ts");
	});

	it("leaves a header-only section (no hunks) alone", () => {
		const rename = [
			"diff --git a/old.ts b/new.ts",
			"similarity index 100%",
			"rename from old.ts",
			"rename to new.ts",
			"",
		].join("\n");
		const filler = fileSection("big.ts", 2_000);
		const out = elideLargeDiffSections(rename + filler, { perFileBytes: 1_000, totalBytes: 1_500 });
		expect(out).toContain("rename from old.ts");
	});
});
