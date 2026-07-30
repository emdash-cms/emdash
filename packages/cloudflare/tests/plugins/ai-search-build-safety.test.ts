import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// Build-safety regression guard.
//
// `demos/*/astro.config.mjs` imports `aiSearch` from
// `@emdash-cms/cloudflare/plugins`, so the ai-search module is evaluated by the
// Astro *config loader*, which runs under plain Node ESM. `emdash/middleware`
// transitively imports `astro:middleware` (a virtual module) at its top level.
// If ai-search.ts imports `emdash/middleware` as a VALUE at the top level, that
// specifier is pulled into config evaluation and `astro build` fails with:
//   "Only URLs with a scheme in: file, data, and node are supported ...
//    Received protocol 'astro:'"
//
// The runtime (`withEmDashRuntime`) must therefore be loaded lazily via a
// dynamic `import()` inside the request handler, and any `emdash/middleware`
// reference at the top level must be `import type` only (erased at compile).
const source = readFileSync(
	fileURLToPath(new URL("../../src/plugins/ai-search.ts", import.meta.url)),
	"utf8",
);

describe("ai-search.ts must not eagerly import runtime-only Astro modules", () => {
	it("only references emdash/middleware as `import type` or a dynamic import", () => {
		const lines = source.split("\n");
		const offending: string[] = [];

		for (const raw of lines) {
			const line = raw.trim();
			if (!line.includes("emdash/middleware")) continue;
			const isTypeOnlyImport = /^import\s+type\b/.test(line);
			const isDynamicImport = /\bimport\s*\(/.test(line);
			const isComment = line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
			if (!isTypeOnlyImport && !isDynamicImport && !isComment) {
				offending.push(line);
			}
		}

		expect(
			offending,
			`A top-level value import of "emdash/middleware" breaks \`astro build\` (astro: scheme). ` +
				`Use a dynamic import() inside the handler or \`import type\`. Offending lines:\n` +
				offending.join("\n"),
		).toEqual([]);
	});

	it("loads emdash/middleware through a dynamic import inside the endpoint", () => {
		expect(source).toMatch(/await import\(\s*["']emdash\/middleware["']\s*\)/);
	});
});
