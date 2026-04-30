import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression test for #741 ("Cannot find module 'kysely'" after build).
 *
 * The dialect runtime modules (db/sqlite.ts, db/libsql.ts, db/postgres.ts)
 * are bundled into the user's site dist via `noExternal: ["emdash"]` in
 * the Astro integration's Vite SSR config. If any of them uses CJS
 * `require("kysely")` (or another external) instead of a static `import`,
 * the bundler emits a literal `require("kysely")` call into the user's
 * dist chunks. At runtime under pnpm's strict node_modules layout, that
 * `require()` resolves from the user's `dist/server/chunks/` directory,
 * walks up looking for `node_modules/kysely`, doesn't find it (because
 * kysely is only a transitive dep of `emdash`), and throws
 * `MODULE_NOT_FOUND`.
 *
 * Static `import`s let Vite either externalize the dep correctly or pull
 * it into the bundle. Either outcome resolves at runtime; the dynamic
 * `require()` form does not. Keep these files static-import-only.
 */
describe("dialect runtime modules", () => {
	const dialectFiles = [
		fileURLToPath(new URL("../../../src/db/sqlite.ts", import.meta.url)),
		fileURLToPath(new URL("../../../src/db/libsql.ts", import.meta.url)),
		fileURLToPath(new URL("../../../src/db/postgres.ts", import.meta.url)),
	];

	for (const file of dialectFiles) {
		it(`${file.split("/db/")[1]} does not use require() to load externals`, () => {
			const source = readFileSync(file, "utf-8");
			// Strip line comments (`//`), block comments (`/* … */`), and string
			// literals before scanning. We only care about actual code-level
			// `require(` calls; a docstring or inline comment that mentions
			// the historical bug should not trip the assertion.
			const codeOnly = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|[^:])\/\/.*$/gm, "$1")
				.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
			// Any standalone require( call in these files re-introduces the
			// bug: the bundler leaves it as-is, and runtime resolution under
			// pnpm fails for transitive deps like `kysely`.
			expect(codeOnly).not.toMatch(/(?<![.\w])require\s*\(/);
		});
	}
});
