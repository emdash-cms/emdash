import { describe, expect, it } from "vitest";

import type { ResolvedPlugin } from "../src/bundle/types.js";
import { extractManifest, findNodeBuiltinImports, findSourceExports } from "../src/bundle/utils.js";

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
