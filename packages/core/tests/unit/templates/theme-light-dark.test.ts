import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { transform } from "lightningcss";
import { describe, expect, it, vi } from "vitest";

// The configs are imported for their `vite` options only; stub the EmDash
// packages so the test doesn't need them built.
vi.mock("emdash/astro", () => ({ default: () => ({ name: "emdash" }), local: () => ({}) }));
vi.mock("emdash/db", () => ({ sqlite: () => ({}) }));

// Vite's default `build.cssTarget` ("baseline-widely-available"), which the
// production CSS minifier compiles for. Safari 16.4 predates light-dark().
const VITE_DEFAULT_CSS_TARGETS = {
	chrome: 111 << 16,
	edge: 111 << 16,
	firefox: 114 << 16,
	safari: (16 << 16) | (4 << 8),
};

const TEMPLATES = ["blog", "marketing", "portfolio"] as const;

function templatePath(template: string, file: string): string {
	return fileURLToPath(new URL(`../../../../../templates/${template}/${file}`, import.meta.url));
}

/** The `css: { ... }` block of a template's `vite` config, as written. */
function cssConfigSource(template: string): string | undefined {
	const source = readFileSync(templatePath(template, "astro.config.mjs"), "utf8");
	return source.match(/\n\t\tcss: \{\n[\s\S]*?\n\t\t\},\n/)?.[0];
}

describe.each(TEMPLATES)("%s template theme switcher", (template) => {
	it("keeps light-dark() through the production CSS minifier", async () => {
		const { default: config } = await import(templatePath(template, "astro.config.mjs"));
		const tokens = readFileSync(templatePath(template, "src/styles/tokens.css"));

		// Mirrors Vite's Lightning CSS minify step: the config's
		// css.lightningcss options plus the build CSS targets.
		const { code } = transform({
			...config.vite?.css?.lightningcss,
			targets: VITE_DEFAULT_CSS_TARGETS,
			filename: "tokens.css",
			code: tokens,
			minify: true,
		});
		const css = code.toString();

		// Transpiled light-dark() follows only prefers-color-scheme, so the
		// footer switcher's :root.light / :root.dark color-scheme has no effect.
		expect(css).not.toContain("--lightningcss-light");
		expect(css).toContain("light-dark(");
	});

	// The Cloudflare variant can't be imported here without building
	// @emdash-cms/cloudflare, which the core test job doesn't do.
	it("has the same CSS options in its Cloudflare variant", () => {
		const css = cssConfigSource(template);
		expect(css).toBeDefined();
		expect(cssConfigSource(`${template}-cloudflare`)).toBe(css);
	});
});
