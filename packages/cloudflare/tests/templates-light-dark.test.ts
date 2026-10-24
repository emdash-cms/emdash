import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Vite's default `build.cssTarget` ("baseline-widely-available"), which the
// production CSS minifier compiles the Cloudflare sites for. Safari 16.4
// predates light-dark().
const VITE_DEFAULT_CSS_TARGETS = {
	chrome: 111 << 16,
	edge: 111 << 16,
	firefox: 114 << 16,
	safari: (16 << 16) | (4 << 8),
};

const SITES = [
	"templates/blog-cloudflare",
	"templates/marketing-cloudflare",
	"templates/portfolio-cloudflare",
	"demos/cloudflare",
	"demos/playground",
	"demos/preview",
	"infra/blog-demo",
	"infra/cache-demo",
	"infra/do-demo",
	"infra/do-solo-demo",
] as const;

interface LightningCss {
	transform(options: Record<string, unknown>): { code: Uint8Array };
}

function sitePath(site: string, file: string): string {
	return fileURLToPath(new URL(`../../../${site}/${file}`, import.meta.url));
}

describe.each(SITES)("%s theme switcher", (site) => {
	// Importing a site's Astro config loads Astro, EmDash and any plugins,
	// which can take longer than the default timeout on a cold start.
	it("keeps light-dark() through the production CSS minifier", { timeout: 30_000 }, async () => {
		const { default: config } = await import(sitePath(site, "astro.config.mjs"));
		// The site's own Lightning CSS, the copy Vite minifies its CSS with.
		const require = createRequire(sitePath(site, "package.json"));
		const { transform } = require("lightningcss") as LightningCss;
		const tokens = readFileSync(sitePath(site, "src/styles/tokens.css"));

		// Mirrors Vite's Lightning CSS minify step: the config's
		// css.lightningcss options plus the build CSS targets.
		const { code } = transform({
			...config.vite?.css?.lightningcss,
			targets: VITE_DEFAULT_CSS_TARGETS,
			filename: "tokens.css",
			code: tokens,
			minify: true,
		});
		const css = new TextDecoder().decode(code);

		// Transpiled light-dark() follows only prefers-color-scheme, so the
		// footer switcher's :root.light / :root.dark color-scheme has no effect.
		expect(css).not.toContain("--lightningcss-light");
		expect(css).toContain("light-dark(");
	});
});
