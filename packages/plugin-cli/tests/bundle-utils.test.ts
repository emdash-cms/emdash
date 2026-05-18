import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedPlugin } from "../src/bundle/types.js";
import {
	collectBundleEntries,
	extractManifest,
	findNodeBuiltinImports,
	findSourceExports,
	formatBytes,
	MAX_FILE_COUNT,
	MAX_FILE_SIZE,
	totalBundleBytes,
	validateBundleSize,
} from "../src/bundle/utils.js";

const minimalResolved = (overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin => ({
	id: "test-plugin",
	version: "0.1.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: {},
	routes: {},
	admin: {},
	...overrides,
});

describe("extractManifest", () => {
	it("emits plain hook names when metadata is at defaults", () => {
		const manifest = extractManifest(
			minimalResolved({
				hooks: {
					"content:beforeCreate": {
						handler: () => {},
						priority: 100,
						timeout: 5000,
					},
				},
			}),
		);
		expect(manifest.hooks).toEqual(["content:beforeCreate"]);
	});

	it("emits structured hook entries when metadata differs from defaults", () => {
		const manifest = extractManifest(
			minimalResolved({
				hooks: {
					"email:deliver": {
						handler: () => {},
						priority: 50,
						timeout: 30_000,
						exclusive: true,
					},
				},
			}),
		);
		expect(manifest.hooks).toEqual([
			{ name: "email:deliver", exclusive: true, priority: 50, timeout: 30_000 },
		]);
	});

	it("preserves the route name list", () => {
		const manifest = extractManifest(
			minimalResolved({
				routes: { admin: { handler: () => {} }, api: { handler: () => {} } },
			}),
		);
		expect(manifest.routes.toSorted((a, b) => a.localeCompare(b))).toEqual(["admin", "api"]);
	});

	it("strips the runtime entry pointer from admin", () => {
		const manifest = extractManifest(
			minimalResolved({
				admin: { entry: "@emdash-cms/some/admin", pages: [{ path: "/x" }] },
			}),
		);
		expect(manifest.admin).not.toHaveProperty("entry");
		expect(manifest.admin.pages).toEqual([{ path: "/x" }]);
	});
});

describe("findNodeBuiltinImports", () => {
	it("flags require('node:fs')", () => {
		expect(findNodeBuiltinImports(`require("node:fs")`)).toEqual(["fs"]);
	});

	it("flags require('crypto') without the node: prefix", () => {
		expect(findNodeBuiltinImports(`require('crypto')`)).toEqual(["crypto"]);
	});

	it("flags ESM `import { promises } from 'node:fs'`", () => {
		expect(findNodeBuiltinImports(`import { promises } from "node:fs/promises";`)).toEqual(["fs"]);
	});

	it("flags dynamic `await import('node:child_process')`", () => {
		expect(findNodeBuiltinImports(`await import("node:child_process")`)).toEqual(["child_process"]);
	});

	it("does not flag user-land package names that share a name with a builtin substring", () => {
		// "events-utils" is not the "events" builtin
		expect(findNodeBuiltinImports(`require("events-utils")`)).toEqual([]);
	});

	it("does not flag whitelisted globals like 'astro' or 'react'", () => {
		expect(findNodeBuiltinImports(`import x from "astro"`)).toEqual([]);
		expect(findNodeBuiltinImports(`import x from "react"`)).toEqual([]);
	});

	it("deduplicates repeated imports of the same builtin", () => {
		expect(
			findNodeBuiltinImports(`require("node:fs"); require("fs"); import "node:fs/promises";`),
		).toEqual(["fs"]);
	});

	it("returns empty for builtin-free code", () => {
		expect(findNodeBuiltinImports(`const x = 1; export default x;`)).toEqual([]);
	});
});

describe("findSourceExports", () => {
	it("flags string exports pointing at TypeScript source", () => {
		const issues = findSourceExports({
			".": "./src/index.ts",
			"./util": "./src/util.tsx",
		});
		expect(issues).toEqual([
			{ exportPath: ".", resolvedPath: "./src/index.ts" },
			{ exportPath: "./util", resolvedPath: "./src/util.tsx" },
		]);
	});

	it("flags conditional exports whose `import` resolves to source", () => {
		const issues = findSourceExports({
			".": { import: "./src/index.ts", types: "./dist/index.d.ts" },
		});
		expect(issues).toEqual([{ exportPath: ".", resolvedPath: "./src/index.ts" }]);
	});

	it("does not flag exports pointing at built `.mjs` / `.js` / `.cjs`", () => {
		expect(
			findSourceExports({
				".": "./dist/index.mjs",
				"./util": "./dist/util.js",
				"./cjs": "./dist/util.cjs",
			}),
		).toEqual([]);
	});

	it("ignores non-string, non-import exports", () => {
		expect(
			findSourceExports({
				".": { types: "./dist/index.d.ts" }, // no `import` field
				"./empty": null,
			}),
		).toEqual([]);
	});
});

describe("validateBundleSize", () => {
	it("accepts an empty bundle (boundary: zero files)", () => {
		expect(validateBundleSize([])).toEqual([]);
	});

	it("accepts a bundle that sits exactly at every cap", () => {
		// 19 small files + one file at the per-file cap. Total stays under
		// MAX_BUNDLE_SIZE because per-file cap × file count is much larger
		// than the bundle cap; we deliberately undershoot the total.
		const entries = [
			{ name: "backend.js", bytes: MAX_FILE_SIZE },
			...Array.from({ length: MAX_FILE_COUNT - 1 }, (_, i) => ({
				name: `extra-${i}.js`,
				bytes: 100,
			})),
		];
		expect(validateBundleSize(entries)).toEqual([]);
	});

	it("flags total bundle size when it exceeds MAX_BUNDLE_SIZE without tripping per-file cap", () => {
		// Three files at exactly MAX_FILE_SIZE each — per-file cap is satisfied
		// (`>` not `>=`), but the sum (3 × 128 KB = 384 KB) exceeds the 256 KB
		// total cap. Isolates the total-size assertion from per-file noise.
		const entries = [
			{ name: "a.js", bytes: MAX_FILE_SIZE },
			{ name: "b.js", bytes: MAX_FILE_SIZE },
			{ name: "c.js", bytes: MAX_FILE_SIZE },
		];
		const violations = validateBundleSize(entries);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/Bundle size .* exceeds maximum of/);
	});

	it("does not flag a bundle exactly at MAX_BUNDLE_SIZE", () => {
		// Use MAX_FILE_SIZE-bounded files so per-file cap is satisfied too.
		// MAX_BUNDLE_SIZE / MAX_FILE_SIZE = 256/128 = 2 files.
		const entries = [
			{ name: "a.js", bytes: MAX_FILE_SIZE },
			{ name: "b.js", bytes: MAX_FILE_SIZE },
		];
		expect(validateBundleSize(entries)).toEqual([]);
	});

	it("flags file count when it exceeds MAX_FILE_COUNT", () => {
		const entries = Array.from({ length: MAX_FILE_COUNT + 1 }, (_, i) => ({
			name: `f-${i}.js`,
			bytes: 10,
		}));
		const violations = validateBundleSize(entries);
		expect(violations).toContainEqual(
			expect.stringMatching(new RegExp(`contains ${MAX_FILE_COUNT + 1} files`)),
		);
	});

	it("flags every oversized file individually", () => {
		const entries = [
			{ name: "ok.js", bytes: 100 },
			{ name: "huge-b.js", bytes: MAX_FILE_SIZE + 1 },
			{ name: "huge-a.js", bytes: MAX_FILE_SIZE + 2 },
		];
		const violations = validateBundleSize(entries);
		const fileViolations = violations.filter((v) => v.startsWith("File "));
		expect(fileViolations).toHaveLength(2);
		// Alphabetical ordering — huge-a before huge-b — keeps error text
		// deterministic for the same bundle.
		expect(fileViolations[0]).toMatch(/File huge-a\.js/);
		expect(fileViolations[1]).toMatch(/File huge-b\.js/);
	});

	it("reports total, count, and per-file violations together when all three trip", () => {
		const entries = Array.from({ length: MAX_FILE_COUNT + 5 }, (_, i) => ({
			name: `chunk-${String(i).padStart(2, "0")}.js`,
			bytes: MAX_FILE_SIZE + 1,
		}));
		const violations = validateBundleSize(entries);
		// One total-size violation, one file-count violation, one per oversized file.
		expect(violations[0]).toMatch(/Bundle size/);
		expect(violations[1]).toMatch(/contains/);
		expect(violations.length).toBe(2 + entries.length);
	});

	it("returns the same violation list when called twice with the same input", () => {
		const entries = [
			{ name: "z.js", bytes: MAX_FILE_SIZE + 1 },
			{ name: "a.js", bytes: MAX_FILE_SIZE + 1 },
		];
		expect(validateBundleSize(entries)).toEqual(validateBundleSize(entries));
	});
});

describe("totalBundleBytes", () => {
	it("returns 0 for an empty list", () => {
		expect(totalBundleBytes([])).toBe(0);
	});

	it("sums the byte sizes of all entries", () => {
		expect(
			totalBundleBytes([
				{ name: "a", bytes: 10 },
				{ name: "b", bytes: 20 },
				{ name: "c", bytes: 30 },
			]),
		).toBe(60);
	});
});

describe("collectBundleEntries", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-collect-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns an empty list for an empty directory", async () => {
		expect(await collectBundleEntries(dir)).toEqual([]);
	});

	it("flattens nested directories with forward-slash relative paths", async () => {
		await writeFile(join(dir, "manifest.json"), "{}");
		await mkdir(join(dir, "screenshots"));
		await writeFile(join(dir, "screenshots", "one.png"), "x");
		await writeFile(join(dir, "screenshots", "two.png"), "yz");

		const entries = await collectBundleEntries(dir);
		const byName = Object.fromEntries(entries.map((e) => [e.name, e.bytes]));
		expect(byName).toEqual({
			"manifest.json": 2,
			"screenshots/one.png": 1,
			"screenshots/two.png": 2,
		});
	});

	it("integrates with validateBundleSize for end-to-end cap enforcement", async () => {
		await writeFile(join(dir, "backend.js"), "x".repeat(MAX_FILE_SIZE + 1));
		const violations = validateBundleSize(await collectBundleEntries(dir));
		expect(violations).toContainEqual(expect.stringMatching(/File backend\.js is/));
	});
});

describe("formatBytes", () => {
	it("renders bytes under 1 KB with the B suffix", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("renders KB at one decimal place from 1 KB through just under 1 MB", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(256 * 1024)).toBe("256.0 KB");
	});

	it("renders MB at two decimal places at or above 1 MB", () => {
		expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
	});
});
