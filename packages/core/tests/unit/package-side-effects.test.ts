import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guards the `sideEffects` list in package.json.
 *
 * `emdash`'s main entry re-exports every subsystem, and a site imports
 * `getEmDashCollection` from it. Without a `sideEffects` declaration the
 * bundler has to keep every module that barrel reaches, so the first request
 * on each new Worker isolate evaluated the API schemas, the WordPress
 * importer, the seed applier and more before rendering a page.
 *
 * With the declaration, a module whose exports nobody uses can be dropped,
 * and so can its top-level statements. A module that does real work when it
 * is imported, such as registering something in a shared registry, must be
 * listed, or that work silently disappears from both the package build and
 * the site build. `src/import/index.ts` is the one such module today: it
 * registers the built-in import sources, and without the entry the WordPress
 * importer finds no sources. `tests/unit/import/built-sources.test.ts` checks
 * that against the built package.
 *
 * The guard below only sees top-level calls. A top-level assignment such as
 * `globalThis[KEY] = ...` or a bare `new X()` passes it unnoticed, so a module
 * that does its import-time work that way must be added to the list by hand.
 */
const coreRoot = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf-8")) as {
	sideEffects?: string[] | boolean;
};

/**
 * Top-level statements that are not needed when nothing imports the module:
 * an entry point (always kept by the bundler) and a rejection handler on a
 * promise that only matters to code importing it.
 */
const HARMLESS = new Set(["src/cli/index.ts", "src/after.ts"]);

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path);
		return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
	});
}

/** Lines that call something at module scope, outside any declaration. */
const TOP_LEVEL_CALL = /^(?:void\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/m;

describe("package sideEffects", () => {
	it("is declared, so sites can drop unused subsystems", () => {
		expect(Array.isArray(pkg.sideEffects)).toBe(true);
	});

	it("lists every source module that does work at import time", () => {
		const listed = new Set(
			(Array.isArray(pkg.sideEffects) ? pkg.sideEffects : [])
				.filter((entry) => entry.startsWith("./src/"))
				.map((entry) => entry.slice(2)),
		);
		const unlisted = walk(join(coreRoot, "src"))
			.map((file) => ({ file: relative(coreRoot, file), source: readFileSync(file, "utf-8") }))
			.filter(({ file, source }) => {
				if (HARMLESS.has(file) || listed.has(file)) return false;
				const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
				return TOP_LEVEL_CALL.test(code);
			})
			.map(({ file }) => file);
		expect(unlisted).toEqual([]);
	});

	it("keeps the runtime off the main barrel", () => {
		const runtime = readFileSync(join(coreRoot, "src/emdash-runtime.ts"), "utf-8");
		expect(runtime).not.toMatch(/from\s+["']\.\/index\.js["']/);
	});
});
