import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Walk `src/generated/types/` and pick up every generated `.ts` file as a
 * separate entry point. We need each lexicon module to compile to its own
 * `.js` + `.d.ts` so the `./types/*` package export resolves at every NSID.
 */
function collectGeneratedEntries(): string[] {
	const root = join(here, "src", "generated", "types");
	const entries: string[] = [];
	function walk(dir: string): void {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				walk(path);
			} else if (path.endsWith(".ts")) {
				entries.push(`./${relative(here, path)}`);
			}
		}
	}
	try {
		walk(root);
	} catch {
		// First run before codegen has produced any output -- the build script
		// runs codegen before this config is evaluated, so this is only hit if
		// someone invokes tsdown directly without running the parent build.
	}
	return entries;
}

export default defineConfig({
	entry: ["src/index.ts", ...collectGeneratedEntries()],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "neutral",
	target: "es2023",
	external: ["@atcute/atproto", "@atcute/lexicons"],
});
