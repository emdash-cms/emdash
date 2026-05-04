/**
 * Tests for the `emdash secrets` CLI surface.
 *
 * Focuses on the file-write helper used by `secrets generate --write`,
 * which is the only piece with non-trivial logic. The command runners
 * themselves are thin wrappers around `generateEncryptionKey()` and
 * `fingerprintKey()` (covered by `tests/unit/config/secrets.test.ts`).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { writeEncryptionKeyToFile } from "../../../src/cli/commands/secrets.js";

describe("secrets CLI: writeEncryptionKeyToFile", () => {
	let dir: string;
	let target: string;
	const sample = "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
	const sample2 = "emdash_enc_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-secrets-cli-"));
		target = join(dir, ".dev.vars");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates a new file with a trailing newline", async () => {
		const result = writeEncryptionKeyToFile(target, sample, false);
		expect(result).toBe("wrote");
		const content = await readFile(target, "utf-8");
		expect(content).toBe(`EMDASH_ENCRYPTION_KEY=${sample}\n`);
	});

	it("appends to an existing file without clobbering other vars", async () => {
		await writeFile(target, "OTHER=value\nFOO=bar\n");
		const result = writeEncryptionKeyToFile(target, sample, false);
		expect(result).toBe("wrote");
		const content = await readFile(target, "utf-8");
		expect(content).toBe(`OTHER=value\nFOO=bar\nEMDASH_ENCRYPTION_KEY=${sample}\n`);
	});

	it("appends to a file that lacks a trailing newline", async () => {
		await writeFile(target, "OTHER=value");
		const result = writeEncryptionKeyToFile(target, sample, false);
		expect(result).toBe("wrote");
		const content = await readFile(target, "utf-8");
		expect(content).toBe(`OTHER=value\nEMDASH_ENCRYPTION_KEY=${sample}\n`);
	});

	it("refuses to overwrite an existing entry without force", async () => {
		await writeFile(target, `EMDASH_ENCRYPTION_KEY=${sample}\nOTHER=value\n`);
		const result = writeEncryptionKeyToFile(target, sample2, false);
		expect(result).toBe("skipped");
		const content = await readFile(target, "utf-8");
		// Entry untouched.
		expect(content).toBe(`EMDASH_ENCRYPTION_KEY=${sample}\nOTHER=value\n`);
	});

	it("replaces an existing entry in place when force is true", async () => {
		await writeFile(target, `OTHER=value\nEMDASH_ENCRYPTION_KEY=${sample}\nMORE=stuff\n`);
		const result = writeEncryptionKeyToFile(target, sample2, true);
		expect(result).toBe("wrote");
		const content = await readFile(target, "utf-8");
		// Other vars untouched, key replaced inline (no duplication).
		expect(content).toBe(`OTHER=value\nEMDASH_ENCRYPTION_KEY=${sample2}\nMORE=stuff\n`);
	});

	it("treats an empty-value entry as not-set and replaces it without --force", async () => {
		// Operators sometimes leave `EMDASH_ENCRYPTION_KEY=` as a placeholder.
		// A skip in that case would be hostile — they actively want a value.
		await writeFile(target, `OTHER=value\nEMDASH_ENCRYPTION_KEY=\nMORE=stuff\n`);
		const result = writeEncryptionKeyToFile(target, sample, false);
		expect(result).toBe("wrote");
		const content = await readFile(target, "utf-8");
		expect(content).toBe(`OTHER=value\nEMDASH_ENCRYPTION_KEY=${sample}\nMORE=stuff\n`);
	});

	it("always ends with a trailing newline, even when replacing in-place in a file without one", async () => {
		await writeFile(target, `OTHER=value\nEMDASH_ENCRYPTION_KEY=${sample}`);
		const result = writeEncryptionKeyToFile(target, sample2, true);
		expect(result).toBe("wrote");
		const content = await readFile(target, "utf-8");
		expect(content.endsWith("\n")).toBe(true);
		expect(content).toBe(`OTHER=value\nEMDASH_ENCRYPTION_KEY=${sample2}\n`);
	});
});
