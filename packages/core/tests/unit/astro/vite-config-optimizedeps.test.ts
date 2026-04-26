import type { AstroConfig } from "astro";
import { describe, expect, it } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { createViteConfig } from "../../../src/astro/integration/vite-config.js";

/**
 * Regression for #771: a fresh `npm create emdash@latest && yarn dev` failed
 * dependency optimization on `@tiptap/extension-collaboration` and
 * `@tiptap/y-tiptap`. Neither package is imported in source code or declared
 * as a dependency, but Vite's esbuild dep scanner follows non-static
 * `import()` calls inside `@tiptap/react` / `@tiptap/starter-kit` and tries
 * to resolve them. The fix: list both packages in `optimizeDeps.exclude` so
 * the scanner skips them.
 *
 * Both branches of the integration's vite config (Cloudflare and non-
 * Cloudflare) need the exclusion. The test pins both branches so a future
 * refactor can't quietly drop the entries from one path.
 */
describe("vite-config optimizeDeps exclude (#771)", () => {
	function makeOptions(adapter: "cloudflare" | "node") {
		const astroConfig: Partial<AstroConfig> = {
			adapter:
				adapter === "cloudflare"
					? { name: "@astrojs/cloudflare", hooks: {} }
					: { name: "@astrojs/node", hooks: {} },
		};
		const emdashConfig: Partial<EmDashConfig> = {};
		return {
			astroConfig: astroConfig as AstroConfig,
			emdashConfig: emdashConfig as EmDashConfig,
			plugins: [] as PluginDescriptor[],
		};
	}

	it("excludes @tiptap/extension-collaboration and @tiptap/y-tiptap on the Node path", () => {
		const config = createViteConfig(
			makeOptions("node") as Parameters<typeof createViteConfig>[0],
			"dev",
		);
		const exclude = config.optimizeDeps?.exclude ?? [];
		expect(exclude).toContain("@tiptap/extension-collaboration");
		expect(exclude).toContain("@tiptap/y-tiptap");
		// Sanity-check existing entries are still present so we did not
		// regress the original optimizeDeps shape.
		expect(exclude).toContain("virtual:emdash");
	});

	it("excludes @tiptap/extension-collaboration and @tiptap/y-tiptap on the Cloudflare ssr path", () => {
		const config = createViteConfig(
			makeOptions("cloudflare") as Parameters<typeof createViteConfig>[0],
			"dev",
		);
		// On Cloudflare the exclusion shows up in two places: the
		// adapter-specific ssr.optimizeDeps block, and the top-level
		// optimizeDeps.exclude ternary. Both must carry the entries so a
		// future refactor that drops one path is still caught.
		const ssr = config.ssr as { optimizeDeps?: { exclude?: string[] } } | undefined;
		const ssrExclude = ssr?.optimizeDeps?.exclude ?? [];
		expect(ssrExclude).toContain("@tiptap/extension-collaboration");
		expect(ssrExclude).toContain("@tiptap/y-tiptap");
		expect(ssrExclude).toContain("virtual:emdash");

		const topLevelExclude = config.optimizeDeps?.exclude ?? [];
		expect(topLevelExclude).toContain("@tiptap/extension-collaboration");
		expect(topLevelExclude).toContain("@tiptap/y-tiptap");
	});
});

// Re-declare here to avoid pulling the runtime module's broader type surface
// into a test file. The shape only needs to be assignable; the test does not
// inspect the plugins list.
type PluginDescriptor = {
	name?: string;
	package?: string;
};
