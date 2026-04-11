/**
 * Package Exports Verification
 *
 * Ensures that every path declared in package.json "exports" resolves to
 * a file that actually exists on disk after a build. This would have caught
 * the missing dist/middleware.mjs that shipped in 0.1.0.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8"));

describe("package.json exports", () => {
	const packageExports: Record<string, unknown> = pkg.exports;

	for (const [entrypoint, conditions] of Object.entries(packageExports)) {
		if (conditions == null || typeof conditions !== "object") continue;

		for (const [condition, filepath] of Object.entries(conditions as Record<string, string>)) {
			it(`${entrypoint} → ${condition} (${filepath}) exists`, () => {
				const absolute = resolve(pkgRoot, filepath);
				expect(
					existsSync(absolute),
					`Missing: ${filepath} (required by exports["${entrypoint}"].${condition})`,
				).toBe(true);
			});
		}
	}
});
