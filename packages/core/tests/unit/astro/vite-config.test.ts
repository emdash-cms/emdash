import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import type { AstroConfig } from "astro";
import { describe, expect, it } from "vitest";

import { createViteConfig } from "../../../src/astro/integration/vite-config.js";

describe("createViteConfig admin aliasing", () => {
	const monorepoDemoRoot = new URL("../../../../../demos/simple/", import.meta.url);
	const externalProjectRoot = new URL("file:///workspace/emdash-site/");
	const siblingProjectRoot = new URL("../../../../../../emdash-site/", import.meta.url);
	const adminSourcePattern = /[/\\]packages[/\\]admin[/\\]src$/;
	const adminDistPattern = /[/\\]packages[/\\]admin[/\\]dist$/;

	function buildConfig(root: URL, command: "dev" | "build" | "preview" | "sync" = "dev") {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: {} as never,
				pluginDescriptors: [],
				astroConfig: {
					root,
					adapter: { name: "@astrojs/node" },
				} as AstroConfig,
			},
			command,
		);
	}

	function getAdminAliasReplacement(config: ReturnType<typeof createViteConfig>) {
		const aliases = Array.isArray(config.resolve?.alias) ? config.resolve.alias : [];
		const adminAlias = aliases.find(
			(alias) =>
				typeof alias === "object" &&
				alias !== null &&
				"find" in alias &&
				alias.find === "@emdash-cms/admin" &&
				"replacement" in alias,
		);

		if (!adminAlias || typeof adminAlias.replacement !== "string") {
			throw new Error("Missing @emdash-cms/admin alias");
		}

		return adminAlias.replacement;
	}

	it("uses raw admin source for local monorepo dev", () => {
		const config = buildConfig(monorepoDemoRoot);
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("src");
		expect(replacement).toMatch(adminSourcePattern);
	});

	it("uses built admin dist for external app dev", () => {
		const config = buildConfig(externalProjectRoot);
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("dist");
		expect(replacement).toMatch(adminDistPattern);
	});

	it("uses built admin dist for sibling paths with a matching prefix", () => {
		const config = buildConfig(siblingProjectRoot);
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("dist");
		expect(replacement).toMatch(adminDistPattern);
	});

	it("uses built admin dist outside dev", () => {
		const config = buildConfig(monorepoDemoRoot, "build");
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("dist");
		expect(replacement).toMatch(adminDistPattern);
	});
});

describe("createViteConfig Cloudflare SSR dep optimization", () => {
	const externalProjectRoot = new URL("file:///workspace/emdash-site/");

	function buildConfig() {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: {} as never,
				pluginDescriptors: [],
				astroConfig: {
					root: externalProjectRoot,
					adapter: { name: "@astrojs/cloudflare" },
				} as AstroConfig,
			},
			"dev",
		);
	}

	// Regression: in a real install (not the workspace symlink, which
	// Vite never optimizes), the workerd optimizer bundles emdash's dist and
	// code-splits its lazily-executed dynamic imports (MCP tools, content
	// validation) into hashed chunks. Any mid-session re-optimization deletes
	// those chunks while loaded modules still point at them, so every content
	// write fails with "The file does not exist at .../deps_ssr/..." until the
	// dev server restarts. First-party packages must stay excluded.
	it("excludes first-party packages from the workerd optimizer", () => {
		const config = buildConfig();
		const ssr = config.ssr as { optimizeDeps?: { exclude?: string[] } };
		const exclude = ssr.optimizeDeps?.exclude ?? [];

		expect(exclude).toContain("emdash");
		expect(exclude).toContain("@emdash-cms/admin");
		expect(exclude).toContain("@emdash-cms/cloudflare");
		expect(exclude).toContain("virtual:emdash");
	});

	// These are only reached on the first request to their route/feature, so
	// the startup pass misses them; each late discovery re-optimizes and
	// reloads the worker mid-session.
	it("pre-bundles deps that are only discovered after startup", () => {
		const config = buildConfig();
		const ssr = config.ssr as { optimizeDeps?: { include?: string[] } };
		const include = ssr.optimizeDeps?.include ?? [];

		expect(include).toContain("emdash > kysely/migration");
		expect(include).toContain("astro/zod");
		expect(include).toContain("@astrojs/cloudflare/image-transform-endpoint");
	});
});

describe("createViteConfig use-sync-external-store shim aliasing", () => {
	const externalProjectRoot = new URL("file:///workspace/emdash-site/");

	function buildConfig(adapter: string) {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: {} as never,
				pluginDescriptors: [],
				astroConfig: {
					root: externalProjectRoot,
					adapter: { name: adapter },
				} as AstroConfig,
			},
			"dev",
		);
	}

	function getAlias(config: ReturnType<typeof createViteConfig>, find: string) {
		const aliases = Array.isArray(config.resolve?.alias) ? config.resolve.alias : [];
		return aliases.find(
			(alias) =>
				typeof alias === "object" && alias !== null && "find" in alias && alias.find === find,
		);
	}

	function getAliasReplacement(config: ReturnType<typeof createViteConfig>, find: string) {
		const alias = getAlias(config, find);
		if (!alias || typeof alias !== "object" || !("replacement" in alias)) {
			throw new Error(`Missing alias for ${find}`);
		}
		if (typeof alias.replacement !== "string") {
			throw new Error(`Alias replacement for ${find} is not a string`);
		}
		return alias.replacement;
	}

	// Regression: with pnpm + React 18+, @tiptap/react pulls in
	// `use-sync-external-store/shim` (CJS). Vite can't pre-bundle from the
	// virtual store, so browsers get raw CJS and InlinePortableTextEditor
	// fails to hydrate. The aliases redirect the shim to ESM files that use
	// React's built-in hook without loading the warning-only package main
	// entry on React 18+.
	for (const adapter of ["@astrojs/node", "@astrojs/cloudflare"] as const) {
		it(`redirects use-sync-external-store/shim to React-backed ESM shim files on ${adapter}`, () => {
			const config = buildConfig(adapter);

			const withSelectorPath = getAliasReplacement(
				config,
				"use-sync-external-store/shim/with-selector.js",
			);
			const withSelectorBarePath = getAliasReplacement(
				config,
				"use-sync-external-store/shim/with-selector",
			);
			const indexPath = getAliasReplacement(config, "use-sync-external-store/shim/index.js");
			const shimPath = getAliasReplacement(config, "use-sync-external-store/shim");

			expect(isAbsolute(withSelectorPath)).toBe(true);
			expect(existsSync(withSelectorPath)).toBe(true);
			expect(withSelectorBarePath).toBe(withSelectorPath);
			expect(basename(withSelectorPath)).toBe("use-sync-external-store-with-selector.js");
			expect(isAbsolute(indexPath)).toBe(true);
			expect(existsSync(indexPath)).toBe(true);
			expect(shimPath).toBe(indexPath);
			expect(basename(indexPath)).toBe("use-sync-external-store.js");
		});

		it(`lists the more-specific shim aliases before the directory alias on ${adapter}`, () => {
			const config = buildConfig(adapter);
			const aliases = Array.isArray(config.resolve?.alias) ? config.resolve.alias : [];

			const findIndex = (find: string) =>
				aliases.findIndex(
					(alias) =>
						typeof alias === "object" && alias !== null && "find" in alias && alias.find === find,
				);

			const withSelectorIdx = findIndex("use-sync-external-store/shim/with-selector.js");
			const withSelectorBareIdx = findIndex("use-sync-external-store/shim/with-selector");
			const indexIdx = findIndex("use-sync-external-store/shim/index.js");
			const shimIdx = findIndex("use-sync-external-store/shim");

			expect(withSelectorIdx).toBeGreaterThanOrEqual(0);
			expect(withSelectorBareIdx).toBeGreaterThan(withSelectorIdx);
			expect(indexIdx).toBeGreaterThanOrEqual(0);
			expect(shimIdx).toBeGreaterThan(withSelectorBareIdx);
			expect(shimIdx).toBeGreaterThan(indexIdx);
		});
	}
});
