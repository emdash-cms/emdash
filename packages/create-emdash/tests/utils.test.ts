import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	PROJECT_NAME_PATTERN,
	isDirNonEmpty,
	parseTargetArg,
	sanitizePackageName,
} from "../src/utils.js";

// ---------------------------------------------------------------------------
// sanitizePackageName
// ---------------------------------------------------------------------------
describe("sanitizePackageName", () => {
	it("passes through a valid lowercase name unchanged", () => {
		expect(sanitizePackageName("my-site")).toBe("my-site");
	});

	it("lowercases uppercase characters", () => {
		expect(sanitizePackageName("My-Site")).toBe("my-site");
	});

	it("replaces spaces with hyphens", () => {
		expect(sanitizePackageName("my cool site")).toBe("my-cool-site");
	});

	it("replaces dots with hyphens", () => {
		expect(sanitizePackageName("my.site")).toBe("my-site");
	});

	it("replaces underscores with hyphens", () => {
		expect(sanitizePackageName("my_site")).toBe("my-site");
	});

	it("strips leading hyphens", () => {
		expect(sanitizePackageName("--my-site")).toBe("my-site");
	});

	it("strips trailing hyphens", () => {
		expect(sanitizePackageName("my-site--")).toBe("my-site");
	});

	it("strips both leading and trailing hyphens", () => {
		expect(sanitizePackageName("---my-site---")).toBe("my-site");
	});

	it("handles mixed invalid characters", () => {
		expect(sanitizePackageName("My Cool Site!@#2024")).toBe("my-cool-site---2024");
	});

	it("handles a name that is entirely invalid characters", () => {
		expect(sanitizePackageName("!!!")).toBe("my-site");
	});

	it("handles an empty string", () => {
		expect(sanitizePackageName("")).toBe("my-site");
	});

	it("handles a single period (basename of root on some systems)", () => {
		// basename("/") on some platforms can return "/" which sanitises to "my-site"
		// but basename of a relative "." is ".", which becomes empty after stripping
		expect(sanitizePackageName(".")).toBe("my-site");
	});

	it("handles names starting with numbers", () => {
		expect(sanitizePackageName("123-project")).toBe("123-project");
	});

	it("handles unicode characters", () => {
		expect(sanitizePackageName("mön-prøject")).toBe("m-n-pr-ject");
	});

	it("collapses multiple consecutive invalid chars into individual hyphens", () => {
		// Each invalid char becomes a separate hyphen – no collapsing
		expect(sanitizePackageName("a   b")).toBe("a---b");
	});

	it("handles CamelCase directory names", () => {
		expect(sanitizePackageName("MyProject")).toBe("myproject");
	});

	it("handles paths that look like scoped packages", () => {
		// The @ and / are both invalid, so they become hyphens
		expect(sanitizePackageName("@scope/package")).toBe("scope-package");
	});
});

// ---------------------------------------------------------------------------
// PROJECT_NAME_PATTERN
// ---------------------------------------------------------------------------
describe("PROJECT_NAME_PATTERN", () => {
	const valid = ["my-site", "blog", "a", "123", "my-cool-site-2"];
	const invalid = ["My-Site", "my site", "my.site", "my_site", ".", ".hidden", "@scope/pkg", ""];

	for (const name of valid) {
		it(`accepts "${name}"`, () => {
			expect(PROJECT_NAME_PATTERN.test(name)).toBe(true);
		});
	}

	for (const name of invalid) {
		it(`rejects "${name}"`, () => {
			expect(PROJECT_NAME_PATTERN.test(name)).toBe(false);
		});
	}
});

// ---------------------------------------------------------------------------
// parseTargetArg
// ---------------------------------------------------------------------------
describe("parseTargetArg", () => {
	it("returns undefined when no arguments are passed", () => {
		// process.argv always has at least [node, script]
		expect(parseTargetArg(["node", "script.js"])).toBeUndefined();
	});

	it('returns "." when a dot is the first positional argument', () => {
		expect(parseTargetArg(["node", "script.js", "."])).toBe(".");
	});

	it("returns the project name when passed as a positional argument", () => {
		expect(parseTargetArg(["node", "script.js", "my-project"])).toBe("my-project");
	});

	it("skips flags and returns the first positional argument", () => {
		expect(parseTargetArg(["node", "script.js", "--verbose", "my-project"])).toBe("my-project");
	});

	it("skips all flags when no positional argument exists", () => {
		expect(parseTargetArg(["node", "script.js", "--verbose", "--debug"])).toBeUndefined();
	});

	it("returns the first positional argument when multiple are passed", () => {
		expect(parseTargetArg(["node", "script.js", "first", "second"])).toBe("first");
	});

	it("treats a single-hyphen flag as a flag, not a positional arg", () => {
		expect(parseTargetArg(["node", "script.js", "-v", "my-project"])).toBe("my-project");
	});
});

// ---------------------------------------------------------------------------
// isDirNonEmpty
// ---------------------------------------------------------------------------
describe("isDirNonEmpty", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "create-emdash-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns false for an empty directory", () => {
		expect(isDirNonEmpty(tempDir)).toBe(false);
	});

	it("returns true for a directory with files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		expect(isDirNonEmpty(tempDir)).toBe(true);
	});

	it("returns true for a directory with subdirectories", () => {
		mkdirSync(join(tempDir, "subdir"));
		expect(isDirNonEmpty(tempDir)).toBe(true);
	});

	it("returns false for a non-existent path", () => {
		expect(isDirNonEmpty(join(tempDir, "does-not-exist"))).toBe(false);
	});

	it("returns false for a path that is a file, not a directory", () => {
		const filePath = join(tempDir, "a-file.txt");
		writeFileSync(filePath, "content");
		// readdirSync on a file throws ENOTDIR, which the catch handles
		expect(isDirNonEmpty(filePath)).toBe(false);
	});
});
