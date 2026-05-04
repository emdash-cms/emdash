import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	PROJECT_NAME_PATTERN,
	generateEncryptionKey,
	isDirNonEmpty,
	parseTargetArg,
	sanitizePackageName,
	writeEncryptionKey,
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

// ---------------------------------------------------------------------------
// generateEncryptionKey — format alignment with `emdash`'s parser
// ---------------------------------------------------------------------------
//
// The vendored generator must emit values that pass the canonical-base64url
// check in `packages/core/src/config/secrets.ts`. If the prefix or body
// length ever drifts in core, this test won't catch it directly — but the
// shape assertion here is the same shape `parseEncryptionKeys` checks, so
// any encoding regression will be caught immediately.
//
// We don't import from `emdash` directly because `create-emdash` ships
// without the heavy core dep; the duplication is intentional.
describe("generateEncryptionKey", () => {
	it("produces the v1 prefix and a 43-char unpadded base64url body", () => {
		const key = generateEncryptionKey();
		expect(key).toMatch(/^emdash_enc_v1_[A-Za-z0-9_-]{43}$/);
	});

	it("body decodes to exactly 32 bytes", () => {
		const key = generateEncryptionKey();
		const body = key.slice("emdash_enc_v1_".length);
		// base64url -> Uint8Array; rely on Node's built-in handling.
		const bytes = Buffer.from(body, "base64url");
		expect(bytes.length).toBe(32);
	});

	it("body is canonical (re-encoding decoded bytes yields the same string)", () => {
		// Aligns with `parseEncryptionKeys`'s canonical check. If this
		// fails, the generator and parser have drifted apart.
		const key = generateEncryptionKey();
		const body = key.slice("emdash_enc_v1_".length);
		const bytes = Buffer.from(body, "base64url");
		const reencoded = bytes.toString("base64url");
		expect(reencoded).toBe(body);
	});

	it("produces unique values across calls", () => {
		expect(generateEncryptionKey()).not.toBe(generateEncryptionKey());
	});
});

// ---------------------------------------------------------------------------
// writeEncryptionKey — parallel coverage with the core CLI's helper
// ---------------------------------------------------------------------------
//
// These cases mirror `tests/unit/cli/secrets-commands.test.ts` in the core
// package. The two implementations are independently maintained (per
// scaffold-time-no-emdash-dep constraint) so both need their own tests.
describe("writeEncryptionKey", () => {
	let tempDir: string;
	const fileName = ".dev.vars";
	const sample = "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "create-emdash-key-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function read(): string {
		return readFileSync(join(tempDir, fileName), "utf-8");
	}

	it("creates a new file with a trailing newline when none exists", () => {
		const result = writeEncryptionKey(tempDir, fileName);
		expect(result).toBe("wrote");
		const content = read();
		expect(content).toMatch(/^EMDASH_ENCRYPTION_KEY=emdash_enc_v1_[A-Za-z0-9_-]{43}\n$/);
	});

	it("appends to an existing file without clobbering other vars", () => {
		writeFileSync(join(tempDir, fileName), "OTHER=value\nFOO=bar\n");
		const result = writeEncryptionKey(tempDir, fileName);
		expect(result).toBe("wrote");
		const content = read();
		expect(content).toMatch(
			/^OTHER=value\nFOO=bar\nEMDASH_ENCRYPTION_KEY=emdash_enc_v1_[A-Za-z0-9_-]{43}\n$/,
		);
	});

	it("appends to a file that lacks a trailing newline", () => {
		writeFileSync(join(tempDir, fileName), "OTHER=value");
		const result = writeEncryptionKey(tempDir, fileName);
		expect(result).toBe("wrote");
		const content = read();
		expect(content).toMatch(
			/^OTHER=value\nEMDASH_ENCRYPTION_KEY=emdash_enc_v1_[A-Za-z0-9_-]{43}\n$/,
		);
	});

	it("skips when a populated entry already exists", () => {
		writeFileSync(join(tempDir, fileName), `EMDASH_ENCRYPTION_KEY=${sample}\nOTHER=value\n`);
		const result = writeEncryptionKey(tempDir, fileName);
		expect(result).toBe("skipped");
		const content = read();
		// File untouched.
		expect(content).toBe(`EMDASH_ENCRYPTION_KEY=${sample}\nOTHER=value\n`);
	});

	it("treats an empty-value entry as not-set and replaces it", () => {
		writeFileSync(join(tempDir, fileName), `OTHER=value\nEMDASH_ENCRYPTION_KEY=\nMORE=stuff\n`);
		const result = writeEncryptionKey(tempDir, fileName);
		expect(result).toBe("wrote");
		const content = read();
		expect(content).toMatch(
			/^OTHER=value\nEMDASH_ENCRYPTION_KEY=emdash_enc_v1_[A-Za-z0-9_-]{43}\nMORE=stuff\n$/,
		);
	});

	it("always ends with a trailing newline, even when replacing in-place in a file without one", () => {
		writeFileSync(join(tempDir, fileName), `OTHER=value\nEMDASH_ENCRYPTION_KEY=`);
		const result = writeEncryptionKey(tempDir, fileName);
		expect(result).toBe("wrote");
		const content = read();
		expect(content.endsWith("\n")).toBe(true);
	});
});
