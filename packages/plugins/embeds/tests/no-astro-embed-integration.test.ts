import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression for #938: importing from the top-level `astro-embed` package
 * pulls in `@astro-community/astro-embed-integration`, which depends on
 * `astro-auto-import` (no Astro 6 support). Astro 6's Cloudflare dev
 * runner evaluates modules one at a time inside workerd (no `exports`/
 * `module` globals), so any CJS leakage anywhere in that dependency chain
 * crashes every route with "exports is not defined" -- even though the
 * plugin only ever imports individual embed components, never the
 * integration. Each embed component also ships as its own
 * `@astro-community/astro-embed-*` sub-package with none of that baggage,
 * so importing directly from the sub-package sidesteps the crash entirely.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_SOURCES: Record<string, string> = {
	"Bluesky.astro": "@astro-community/astro-embed-bluesky",
	"Gist.astro": "@astro-community/astro-embed-gist",
	"LinkPreview.astro": "@astro-community/astro-embed-link-preview",
	"Mastodon.astro": "@astro-community/astro-embed-mastodon",
	"Tweet.astro": "@astro-community/astro-embed-twitter",
	"Vimeo.astro": "@astro-community/astro-embed-vimeo",
	"YouTube.astro": "@astro-community/astro-embed-youtube",
};

describe("plugin-embeds does not import through astro-embed (#938)", () => {
	for (const [file, expectedSource] of Object.entries(EXPECTED_SOURCES)) {
		it(`${file} imports its component from ${expectedSource}, not astro-embed`, () => {
			const contents = readFileSync(`${PACKAGE_ROOT}src/astro/${file}`, "utf-8");
			expect(contents).not.toMatch(/from\s+["']astro-embed["']/);
			expect(contents).toMatch(new RegExp(`from\\s+["']${expectedSource}["']`));
		});
	}

	it("package.json does not depend on astro-embed", () => {
		const pkg = JSON.parse(readFileSync(`${PACKAGE_ROOT}package.json`, "utf-8"));
		expect(pkg.dependencies).not.toHaveProperty("astro-embed");
	});

	it("package.json declares each @astro-community/astro-embed-* sub-package used in src/astro", () => {
		const pkg = JSON.parse(readFileSync(`${PACKAGE_ROOT}package.json`, "utf-8"));
		for (const source of Object.values(EXPECTED_SOURCES)) {
			expect(pkg.dependencies).toHaveProperty(source);
		}
	});
});
