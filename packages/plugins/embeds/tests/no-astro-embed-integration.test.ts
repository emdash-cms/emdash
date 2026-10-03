import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression for #938 (Bluesky only): astro-embed-bluesky depends on
 * @atproto/api, whose CommonJS build (transitively multiformats) crashes
 * Astro 6's Cloudflare dev runner the same way -- workerd evaluates modules
 * one at a time with no exports/module globals, so any CJS leakage crashes
 * every route with "exports is not defined". Bluesky posts render via
 * Bluesky's own oEmbed endpoint instead, with no astro-embed dependency.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("plugin-embeds does not import astro-embed-bluesky or @atproto/api (#938)", () => {
	it("Bluesky.astro does not import astro-embed-bluesky or @atproto/api", () => {
		const contents = readFileSync(`${PACKAGE_ROOT}src/astro/Bluesky.astro`, "utf-8");
		expect(contents).not.toMatch(/from\s+["']@astro-community\/astro-embed-bluesky["']/);
		expect(contents).not.toMatch(/from\s+["']@atproto\/api["']/);
	});

	it("package.json does not depend on astro-embed-bluesky or @atproto/api", () => {
		const pkg = JSON.parse(readFileSync(`${PACKAGE_ROOT}package.json`, "utf-8"));
		expect(pkg.dependencies).not.toHaveProperty("@astro-community/astro-embed-bluesky");
		expect(pkg.dependencies).not.toHaveProperty("@atproto/api");
	});
});
