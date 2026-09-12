/**
 * End-to-end coverage for `scaffold()`: the filesystem half of init.
 *
 * Each test runs against a fresh tempdir so writes don't collide. The
 * suite's job is to verify the file tree, the overwrite policy, and
 * the "the scaffold round-trips through the loader" invariant — the
 * scaffolder shouldn't produce a manifest that its own validator
 * rejects (when the user has supplied all required fields).
 */

import {
	lstat,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InitError, scaffold } from "../src/init/scaffold.js";
import type { ScaffoldInputs } from "../src/init/templates.js";
import { loadManifest } from "../src/manifest/load.js";

const FULL_INPUTS: ScaffoldInputs = {
	slug: "gallery",
	publisher: "did:plc:abc123def456",
	publisherHandle: "example.com",
	license: "MIT",
	author: { name: "Jane Doe" },
	security: { email: "security@example.com" },
	description: undefined,
	repo: undefined,
	packageManager: "npm",
	packageManagerVersion: "11.6.2",
	cliVersion: "0.10.0",
};

const MINIMAL_INPUTS: ScaffoldInputs = {
	slug: "gallery",
	publisher: undefined,
	publisherHandle: undefined,
	license: undefined,
	author: undefined,
	security: undefined,
	description: undefined,
	repo: undefined,
	packageManager: "npm",
	packageManagerVersion: "11.6.2",
	cliVersion: "0.10.0",
};

describe("scaffold", () => {
	let targetDir: string;

	beforeEach(async () => {
		// Each test gets its own tempdir, then immediately removes the
		// dir so the scaffolder is creating from scratch (matches what
		// a real `init` invocation does into a brand-new directory).
		const root = await mkdtemp(join(tmpdir(), "emdash-init-test-"));
		targetDir = join(root, "plugin");
	});

	afterEach(async () => {
		// rm the parent root, not just targetDir, so we don't leak
		// the mkdtemp parent behind.
		const root = targetDir.replace(/\/plugin$/, "");
		await rm(root, { recursive: true, force: true });
	});

	it("writes the expected file tree", async () => {
		const result = await scaffold({ targetDir, inputs: FULL_INPUTS, force: false });
		expect(result.written).toHaveLength(12);

		// Spot-check the structure rather than pinning the array order.
		const fileSet = new Set(result.written.map((p) => p.replace(`${targetDir}/`, "")));
		expect(fileSet.has("emdash-plugin.jsonc")).toBe(true);
		expect(fileSet.has("package.json")).toBe(true);
		expect(fileSet.has("tsconfig.json")).toBe(true);
		expect(fileSet.has(".gitignore")).toBe(true);
		expect(fileSet.has("README.md")).toBe(true);
		expect(fileSet.has("src/plugin.ts")).toBe(true);
		expect(fileSet.has("tests/plugin.test.ts")).toBe(true);
		expect(fileSet.has("AGENTS.md")).toBe(true);
		expect(fileSet.has("skills/creating-plugins/SKILL.md")).toBe(true);
		expect(fileSet.has(".agents/skills")).toBe(true);
		expect(fileSet.has(".claude/skills")).toBe(true);
		expect(fileSet.has(".claude/CLAUDE.md")).toBe(true);
	});

	it("links Codex and Claude skill discovery to the canonical skill directory", async () => {
		await scaffold({ targetDir, inputs: FULL_INPUTS, force: false });
		for (const directory of [".agents", ".claude"]) {
			const link = join(targetDir, directory, "skills");
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			expect(await readlink(link)).toBe("../skills");
			expect(await realpath(join(link, "creating-plugins", "SKILL.md"))).toBe(
				await realpath(join(targetDir, "skills", "creating-plugins", "SKILL.md")),
			);
		}
		expect(await readlink(join(targetDir, ".claude", "CLAUDE.md"))).toBe("../AGENTS.md");
		expect(await realpath(join(targetDir, ".claude", "CLAUDE.md"))).toBe(
			await realpath(join(targetDir, "AGENTS.md")),
		);
	});

	it("produces a manifest that the loader accepts", async () => {
		await scaffold({ targetDir, inputs: FULL_INPUTS, force: false });
		const { manifest } = await loadManifest(targetDir);
		expect(manifest.slug).toBe("gallery");
		// `version` is intentionally omitted from the scaffold manifest;
		// the build reads it from package.json instead.
		expect(manifest.version).toBeUndefined();
		expect(manifest.publisher).toBe("did:plc:abc123def456");
		expect(manifest.license).toBe("MIT");
	});

	it("validates the rendered manifest before writing files", async () => {
		await expect(
			scaffold({
				targetDir,
				inputs: { ...FULL_INPUTS, repo: "http://example.com/gallery" },
				force: false,
			}),
		).rejects.toMatchObject({ name: "InitError", code: "INVALID_MANIFEST" });
		await expect(stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses to write a scaffold with missing required ownership metadata", async () => {
		await expect(
			scaffold({ targetDir, inputs: MINIMAL_INPUTS, force: false }),
		).rejects.toMatchObject({ name: "InitError", code: "INVALID_MANIFEST" });
		await expect(stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses to overwrite an existing file without --force", async () => {
		// Pre-create one of the target files with different content.
		const { mkdir } = await import("node:fs/promises");
		await mkdir(targetDir, { recursive: true });
		await writeFile(join(targetDir, "package.json"), "{}", "utf8");

		await expect(scaffold({ targetDir, inputs: FULL_INPUTS, force: false })).rejects.toMatchObject({
			name: "InitError",
			code: "TARGET_FILE_EXISTS",
			conflicts: ["package.json"],
		});

		// The original file must be untouched.
		const contents = await readFile(join(targetDir, "package.json"), "utf8");
		expect(contents).toBe("{}");
	});

	it("does not partially write when a conflict is detected", async () => {
		// Same setup as above. The conflict check runs BEFORE any
		// write, so nothing else should appear in the target dir.
		const { mkdir } = await import("node:fs/promises");
		await mkdir(targetDir, { recursive: true });
		await writeFile(join(targetDir, "package.json"), "{}", "utf8");

		await expect(scaffold({ targetDir, inputs: FULL_INPUTS, force: false })).rejects.toThrow(
			InitError,
		);

		const entries = await readdir(targetDir);
		// Only the pre-existing file should be there.
		expect(entries).toEqual(["package.json"]);
	});

	it("rejects a parent path occupied by a file before writing anything", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(targetDir, { recursive: true });
		await writeFile(join(targetDir, "src"), "occupied", "utf8");

		await expect(scaffold({ targetDir, inputs: FULL_INPUTS, force: false })).rejects.toMatchObject({
			name: "InitError",
			code: "TARGET_FILE_EXISTS",
		});
		expect(await readdir(targetDir)).toEqual(["src"]);
	});

	it("does not follow a generated-file symlink when force is enabled", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(targetDir, { recursive: true });
		const outside = join(targetDir, "..", "outside-readme");
		await writeFile(outside, "keep me", "utf8");
		await symlink(outside, join(targetDir, "README.md"));

		await expect(scaffold({ targetDir, inputs: FULL_INPUTS, force: true })).rejects.toMatchObject({
			name: "InitError",
			code: "TARGET_FILE_EXISTS",
		});
		expect(await readFile(outside, "utf8")).toBe("keep me");
	});

	it("overwrites existing files when --force is set", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(targetDir, { recursive: true });
		await writeFile(join(targetDir, "package.json"), "{}", "utf8");

		await scaffold({ targetDir, inputs: FULL_INPUTS, force: true });
		const contents = await readFile(join(targetDir, "package.json"), "utf8");
		// The scaffold wrote the real package.json over the stub.
		const parsed = JSON.parse(contents) as { name: string };
		expect(parsed.name).toBe("gallery");
	});

	it("creates intermediate directories (src/, tests/)", async () => {
		await scaffold({ targetDir, inputs: FULL_INPUTS, force: false });
		const srcStat = await stat(join(targetDir, "src"));
		const testsStat = await stat(join(targetDir, "tests"));
		expect(srcStat.isDirectory()).toBe(true);
		expect(testsStat.isDirectory()).toBe(true);
	});

	it("invokes onFileWritten once per file in scaffold order", async () => {
		const calls: string[] = [];
		await scaffold({
			targetDir,
			inputs: FULL_INPUTS,
			force: false,
			onFileWritten: (rel) => calls.push(rel),
		});
		// The seven files, in some deterministic order (see FILES in
		// scaffold.ts). The exact order is part of the API surface
		// for CLI progress output.
		expect(calls).toEqual([
			"emdash-plugin.jsonc",
			"package.json",
			"tsconfig.json",
			".gitignore",
			"README.md",
			"src/plugin.ts",
			"tests/plugin.test.ts",
			"AGENTS.md",
			"skills/creating-plugins/SKILL.md",
			".agents/skills",
			".claude/skills",
			".claude/CLAUDE.md",
		]);
	});

	it("adds pnpm install policy only for pnpm scaffolds", async () => {
		const result = await scaffold({
			targetDir,
			inputs: { ...FULL_INPUTS, packageManager: "pnpm" },
			force: false,
		});
		expect(result.written.map((path) => path.replace(`${targetDir}/`, ""))).toContain(
			"pnpm-workspace.yaml",
		);
	});
});
