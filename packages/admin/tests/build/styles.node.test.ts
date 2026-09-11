// @vitest-environment node
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Return true when `css` contains a generated rule selector for the given
 * Tailwind utility class. Tailwind escapes colons, slashes and brackets in
 * the minified selector, so we strip those escaping backslashes and then
 * match the plain selector followed by an opening brace.
 */
function cssHasClass(css: string, className: string): boolean {
	const normalized = css.replace(/\\/g, "");
	const escaped = className.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
	// Tailwind v4 data variants append an attribute selector (e.g.
	// `[data-starting-style]`) before the declaration block.
	return new RegExp(String.raw`\.${escaped}(?:\[[^\]]*\])?\s*\{`).test(normalized);
}

describe("dist/styles.css", () => {
	it("emits the Kumo Dialog positioning utilities", () => {
		const outDir = mkdtempSync(join(tmpdir(), "admin-styles-"));
		const outFile = join(outDir, "styles.css");
		try {
			execSync("pnpm exec tailwindcss -i src/styles.css -o " + outFile + " --minify", {
				cwd: packageDir,
				stdio: "pipe",
			});

			const css = readFileSync(outFile, "utf8");

			// These classes come from Kumo Dialog's `dialogVariants()` function.
			// They are assembled by the local `cn()` utility at runtime, so the
			// Tailwind v4 scanner does not discover them from the compiled Kumo
			// JS. Without an explicit safelist source they are missing from the
			// shipped stylesheet and dialogs render off-screen or uncentered.
			const required = [
				"top-1/2",
				"left-1/2",
				"-translate-x-1/2",
				"-translate-y-1/2",
				"w-full",
				"sm:w-auto",
				"max-w-[calc(100vw-2rem)]",
				"overflow-hidden",
				"rounded-xl",
				"bg-kumo-base",
				"text-kumo-default",
				"duration-150",
				"data-starting-style:scale-90",
				"data-starting-style:opacity-0",
				"data-ending-style:scale-90",
				"data-ending-style:opacity-0",
				"sm:min-w-96",
			];

			for (const className of required) {
				expect(cssHasClass(css, className)).toBe(true);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
