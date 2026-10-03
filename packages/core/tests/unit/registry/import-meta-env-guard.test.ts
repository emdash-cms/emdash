/**
 * Headless (plain Node) safety net for `import.meta.env` accesses.
 *
 * `import.meta.env` only exists under Vite/Astro. Core's dist is plain ESM
 * (tsdown does not define `import.meta.env`), so any non-optional
 * `import.meta.env.<prop>` read in code reachable outside the Astro surface
 * throws a TypeError under plain Node — e.g. headless `installRegistryPins`
 * runs from the site template's setup script.
 *
 * Under vitest, Vite injects `import.meta.env`, so the throw cannot be
 * reproduced in-process; exercise the built dist under plain Node in a
 * post-build smoke instead. This test pins the invariant at source level:
 * every module outside the Astro-only surface that reads
 * `import.meta.env.<prop>` without optional
 * chaining must also carry a `typeof import.meta.env` guard (the pattern
 * established in `astro/dev-typegen.ts`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = join(import.meta.dirname, "../../../src");

/** Matches a throwing (non-optional-chained) property read. */
const BARE_ACCESS = /import\.meta\.env\s*\.\s*[A-Za-z_$]/;
/** Matches the safe-dev guard pattern (`typeof import.meta.env ...`). */
const GUARD = /typeof\s+import\.meta\.env/;
/** `import.meta.env?.DEV` — optional chaining is safe under plain Node. */
const OPTIONAL_ACCESS = /import\.meta\.env\?\./;

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) yield full;
	}
}

/** Comment-only lines can't execute; drop them before scanning. */
function codeLines(file: string): string[] {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			return (
				trimmed !== "" &&
				!trimmed.startsWith("//") &&
				!trimmed.startsWith("*") &&
				!trimmed.startsWith("/*")
			);
		});
}

/**
 * Modules only ever loaded inside an Astro (Vite) build, where
 * `import.meta.env` is defined in dev and statically replaced in production
 * builds. Their bare accesses are fine and out of scope here.
 */
function isViteOnlySource(rel: string): boolean {
	return (
		rel.startsWith(`astro${sep}`) ||
		rel.startsWith(`components${sep}`) ||
		rel.startsWith(`astro-integration${sep}`)
	);
}

describe("plain-Node import.meta.env sweep (packages/core/src)", () => {
	const offending: string[] = [];
	const sources = [...walk(SRC_ROOT)].filter((file) => !isViteOnlySource(relative(SRC_ROOT, file)));

	it("every non-Vite-only module with a bare import.meta.env access carries a typeof guard", () => {
		for (const file of sources) {
			// Only executable lines count — doc comments quote the pattern
			// (e.g. preview/tokens.ts shows `import.meta.env.PREVIEW_SECRET`
			// in a JSDoc example).
			const lines = codeLines(file).filter((l) => BARE_ACCESS.test(l) && !OPTIONAL_ACCESS.test(l));
			if (lines.length === 0) continue;
			if (GUARD.test(readFileSync(file, "utf8"))) continue;
			offending.push(`${relative(SRC_ROOT, file)}: ${lines.join(" | ")}`);
		}
		expect(offending).toEqual([]);
	});

	it("the headless install path guards its import.meta.env.DEV reads", () => {
		const expectGuarded = (rel: string, needle: RegExp) => {
			const text = readFileSync(join(SRC_ROOT, rel), "utf8");
			expect(text, rel).toMatch(GUARD);
			expect(text, rel).toMatch(needle);
		};
		// Registry artifact URL validation (headless pin installs fetch artifacts).
		expectGuarded(
			join("registry", "artifact-fetch.ts"),
			/typeof import\.meta\.env !== "undefined" && import\.meta\.env\.DEV/,
		);
		// Artifact fetch transport inside the install handler.
		expectGuarded(
			join("api", "handlers", "registry.ts"),
			/allowHttpLocalhost:\s*typeof import\.meta\.env !== "undefined" && import\.meta\.env\.DEV/,
		);
		// Aggregator URL validation (also reached via coerceRegistryConfig).
		expectGuarded(
			join("registry", "config.ts"),
			/options\.allowLocalhost \?\?\s*(\/\/[^\n]*\n\s*)*\(typeof import\.meta\.env !== "undefined" && import\.meta\.env\.DEV\)/,
		);
	});
});
