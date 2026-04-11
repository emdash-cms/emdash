/**
 * Tests for bundle utility functions.
 *
 * Focuses on the functions where bugs would be non-obvious:
 * - Tarball round-trip (custom tar implementation)
 * - Manifest extraction (shape transformation, function stripping)
 * - Source entry resolution (path mapping logic)
 * - Node.js built-in detection (regex against bundled output)
 */

import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
	extractManifest,
	createTarball,
	resolveSourceEntry,
	findNodeBuiltinImports,
	findBuildOutput,
	findSourceExports,
} from "../../../src/cli/commands/bundle-utils.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";

function mockPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: {},
		routes: {},
		admin: { pages: [], widgets: [] },
		...overrides,
	};
}

describe("extractManifest", () => {
	it("converts hooks from handler objects to name array", () => {
		const plugin = mockPlugin({
			hooks: {
				"content:beforeSave": {
					handler: vi.fn(),
					priority: 100,
					timeout: 5000,
					dependencies: [],
					errorPolicy: "abort",
					pluginId: "test",
					exclusive: false,
				},
				"media:afterUpload": {
					handler: vi.fn(),
					priority: 50,
					timeout: 5000,
					dependencies: [],
					errorPolicy: "abort",
					pluginId: "test",
					exclusive: false,
				},
			},
		});

		const manifest = extractManifest(plugin);
		// content:beforeSave has all defaults → plain string
		// media:afterUpload has non-default priority → structured entry
		expect(manifest.hooks).toEqual([
			"content:beforeSave",
			{ name: "media:afterUpload", priority: 50 },
		]);
	});

	it("converts routes from handler objects to name array", () => {
		const plugin = mockPlugin({
			routes: {
				sync: { handler: vi.fn() },
				webhook: { handler: vi.fn() },
			},
		});

		const manifest = extractManifest(plugin);
		expect(manifest.routes).toEqual(["sync", "webhook"]);
	});

	it("strips admin.entry (host-only concern, not in bundles)", () => {
		const plugin = mockPlugin({
			admin: {
				entry: "@test/plugin/admin",
				settingsSchema: { apiKey: { type: "string", label: "Key" } as any },
				pages: [{ id: "settings", title: "Settings" }],
				widgets: [],
			},
		});

		const manifest = extractManifest(plugin);
		expect((manifest.admin as any).entry).toBeUndefined();
		expect(manifest.admin.settingsSchema).toBeDefined();
		expect(manifest.admin.pages).toHaveLength(1);
	});

	it("result is JSON-serializable (no functions survive)", () => {
		const plugin = mockPlugin({
			hooks: {
				"content:beforeSave": {
					handler: vi.fn(),
					priority: 100,
					timeout: 5000,
					dependencies: [],
					errorPolicy: "abort",
					pluginId: "test",
					exclusive: false,
				},
			},
			routes: { sync: { handler: vi.fn() } },
		});

		const manifest = extractManifest(plugin);
		const json = JSON.stringify(manifest);
		const parsed = JSON.parse(json);

		expect(parsed.hooks).toEqual(["content:beforeSave"]);
		expect(parsed.routes).toEqual(["sync"]);
	});
});

describe("createTarball", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "emdash-tar-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("produces a tarball that system tar can list", async () => {
		const srcDir = join(tempDir, "src");
		await mkdir(srcDir);
		await writeFile(join(srcDir, "manifest.json"), '{"id":"test"}');
		await writeFile(join(srcDir, "backend.js"), "export default {}");

		const out = join(tempDir, "out.tar.gz");
		await createTarball(srcDir, out);

		const listing = execSync(`tar tzf "${out}"`, { encoding: "utf-8" });
		const files = listing.trim().split("\n").toSorted();
		expect(files).toContain("manifest.json");
		expect(files).toContain("backend.js");
	});

	it("preserves file content through pack/unpack", async () => {
		const srcDir = join(tempDir, "src");
		await mkdir(srcDir);
		const content = JSON.stringify({ id: "round-trip", version: "2.0.0" });
		await writeFile(join(srcDir, "manifest.json"), content);

		const out = join(tempDir, "out.tar.gz");
		await createTarball(srcDir, out);

		const extractDir = join(tempDir, "extract");
		await mkdir(extractDir);
		execSync(`tar xzf "${out}" -C "${extractDir}"`);

		expect(await readFile(join(extractDir, "manifest.json"), "utf-8")).toBe(content);
	});

	it("handles nested directories (screenshots/)", async () => {
		const srcDir = join(tempDir, "src");
		await mkdir(join(srcDir, "screenshots"), { recursive: true });
		await writeFile(join(srcDir, "manifest.json"), "{}");
		await writeFile(join(srcDir, "screenshots", "shot1.png"), "fake");

		const out = join(tempDir, "out.tar.gz");
		await createTarball(srcDir, out);

		const listing = execSync(`tar tzf "${out}"`, { encoding: "utf-8" });
		expect(listing).toContain("screenshots/shot1.png");
	});

	it("handles binary content without corruption", async () => {
		const srcDir = join(tempDir, "src");
		await mkdir(srcDir);
		// Write bytes that would break text-mode handling
		const binary = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		await writeFile(join(srcDir, "icon.png"), binary);

		const out = join(tempDir, "out.tar.gz");
		await createTarball(srcDir, out);

		const extractDir = join(tempDir, "extract");
		await mkdir(extractDir);
		execSync(`tar xzf "${out}" -C "${extractDir}"`);

		const extracted = await readFile(join(extractDir, "icon.png"));
		expect(extracted.equals(binary)).toBe(true);
	});
});

describe("resolveSourceEntry", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "emdash-resolve-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("maps ./dist/index.mjs → src/index.ts", async () => {
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(join(tempDir, "src", "index.ts"), "");

		const result = await resolveSourceEntry(tempDir, "./dist/index.mjs");
		expect(result).toBe(join(tempDir, "src", "index.ts"));
	});

	it("maps ./dist/index.js → src/index.ts", async () => {
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(join(tempDir, "src", "index.ts"), "");

		const result = await resolveSourceEntry(tempDir, "./dist/index.js");
		expect(result).toBe(join(tempDir, "src", "index.ts"));
	});

	it("falls back to .tsx when .ts doesn't exist", async () => {
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(join(tempDir, "src", "index.tsx"), "");

		const result = await resolveSourceEntry(tempDir, "./dist/index.mjs");
		expect(result).toBe(join(tempDir, "src", "index.tsx"));
	});

	it("returns the direct path if it already exists", async () => {
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(join(tempDir, "src", "index.ts"), "");

		const result = await resolveSourceEntry(tempDir, "src/index.ts");
		expect(result).toBe(join(tempDir, "src", "index.ts"));
	});

	it("returns undefined when nothing matches", async () => {
		const result = await resolveSourceEntry(tempDir, "./dist/missing.mjs");
		expect(result).toBeUndefined();
	});
});

describe("findBuildOutput", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "emdash-build-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("prefers .mjs over .js", async () => {
		await writeFile(join(tempDir, "index.mjs"), "");
		await writeFile(join(tempDir, "index.js"), "");

		expect(await findBuildOutput(tempDir, "index")).toBe(join(tempDir, "index.mjs"));
	});

	it("falls back through .js then .cjs", async () => {
		await writeFile(join(tempDir, "index.cjs"), "");
		expect(await findBuildOutput(tempDir, "index")).toBe(join(tempDir, "index.cjs"));
	});

	it("returns undefined when no match", async () => {
		expect(await findBuildOutput(tempDir, "index")).toBeUndefined();
	});
});

describe("findNodeBuiltinImports", () => {
	it("detects require('node:fs') in bundled output", () => {
		expect(findNodeBuiltinImports(`const fs = require("node:fs");`)).toEqual(["fs"]);
	});

	it("detects require('fs') without node: prefix", () => {
		expect(findNodeBuiltinImports(`const fs = require("fs");`)).toEqual(["fs"]);
	});

	it("detects dynamic import('node:child_process')", () => {
		expect(findNodeBuiltinImports(`await import("node:child_process")`)).toEqual(["child_process"]);
	});

	it("returns empty for code with no builtins", () => {
		expect(findNodeBuiltinImports(`import("emdash"); require("lodash");`)).toEqual([]);
	});

	it("deduplicates repeated requires", () => {
		const code = `require("node:fs"); require("node:fs");`;
		expect(findNodeBuiltinImports(code)).toEqual(["fs"]);
	});
});

describe("findSourceExports", () => {
	it("flags .ts exports", () => {
		const issues = findSourceExports({ ".": "./src/index.ts" });
		expect(issues).toEqual([{ exportPath: ".", resolvedPath: "./src/index.ts" }]);
	});

	it("flags .tsx exports", () => {
		const issues = findSourceExports({ "./admin": "./src/admin.tsx" });
		expect(issues).toEqual([{ exportPath: "./admin", resolvedPath: "./src/admin.tsx" }]);
	});

	it("flags .mts exports", () => {
		const issues = findSourceExports({ ".": "./src/index.mts" });
		expect(issues).toHaveLength(1);
	});

	it("flags .cts exports", () => {
		const issues = findSourceExports({ ".": "./src/index.cts" });
		expect(issues).toHaveLength(1);
	});

	it("flags .jsx exports", () => {
		const issues = findSourceExports({ ".": "./src/index.jsx" });
		expect(issues).toHaveLength(1);
	});

	it("accepts .mjs exports", () => {
		const issues = findSourceExports({ ".": "./dist/index.mjs" });
		expect(issues).toEqual([]);
	});

	it("accepts .js exports", () => {
		const issues = findSourceExports({ ".": "./dist/index.js" });
		expect(issues).toEqual([]);
	});

	it("handles conditional exports with import field", () => {
		const issues = findSourceExports({
			".": { import: "./src/index.ts", types: "./dist/index.d.mts" },
		});
		expect(issues).toEqual([{ exportPath: ".", resolvedPath: "./src/index.ts" }]);
	});

	it("accepts conditional exports pointing to built files", () => {
		const issues = findSourceExports({
			".": { import: "./dist/index.mjs", types: "./dist/index.d.mts" },
		});
		expect(issues).toEqual([]);
	});

	it("flags multiple bad exports", () => {
		const issues = findSourceExports({
			".": "./src/index.ts",
			"./sandbox": "./src/sandbox-entry.ts",
		});
		expect(issues).toHaveLength(2);
	});
});
