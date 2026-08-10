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
