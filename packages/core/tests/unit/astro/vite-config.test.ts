import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { AstroConfig } from "astro";
import { describe, expect, it } from "vitest";

import { createViteConfig, linguiMacroPlugin } from "../../../src/astro/integration/vite-config.js";

// Vite/Rollup type hook fields as `T | { handler: T; order?: ... }`. This
// plugin always uses the plain-function form, so unwrap that shape to get a
// directly callable function without pulling in Rollup's types as a dependency.
function unwrapHook<T>(hook: T | { handler: T } | null | undefined): T {
	if (hook == null) throw new Error("Hook is not defined");
	if (typeof hook === "object" && "handler" in hook) return hook.handler;
	return hook;
}

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

// Regression: on Windows, `path.resolve()` returns backslash-separated
// paths, but Vite always normalizes module ids/importers to forward
// slashes — even on Windows. `linguiMacroPlugin` used to compare an
// `adminSourcePath` straight out of `resolve()` against those ids with
// `id.startsWith(adminSourcePath)`, which is silently always `false` on
// Windows. The plugin's hooks became permanent no-ops there: Lingui macro
// calls (`@lingui/core/macro`) shipped uncompiled to the browser, which
// then failed to hydrate the admin UI entirely (it never got past the
// "Loading EmDash..." screen). These tests reproduce that mismatch
// directly, with a synthetic backslash `adminSourcePath` — independent of
// the host OS running the test — so they fail on the pre-fix
// `id.startsWith(adminSourcePath)` comparison on any platform, not just
// Windows CI.
describe("linguiMacroPlugin Windows path-separator handling", () => {
	const require = createRequire(import.meta.url);
	const adminDistPath = dirname(require.resolve("@emdash-cms/admin"));
	// Derive both separator styles deterministically from the real (OS-native)
	// path so this test proves the same thing whether it runs on Windows,
	// macOS, or Linux. `adminSourcePathPosix` stands in for what Vite always
	// hands hooks (forward slashes); `adminSourcePathWindows` stands in for
	// what `path.resolve()` returns on win32 (backslashes) — on a real
	// Windows host these would otherwise be identical and this test would
	// prove nothing.
	const adminSourceDirNative = resolve(adminDistPath, "..", "src");
	const adminSourcePathPosix = adminSourceDirNative.replaceAll("\\", "/");
	const adminSourcePathWindows = adminSourcePathPosix.replaceAll("/", "\\");

	const plugin = linguiMacroPlugin(adminSourcePathWindows, adminDistPath);

	it("compiles away @lingui macro calls in admin source files", async () => {
		const id = `${adminSourcePathPosix}/components/Example.tsx`;
		const code = ['import { t } from "@lingui/core/macro";', "t`Hello`;", ""].join("\n");

		const transform = unwrapHook(plugin.transform);
		const result = await transform.call(
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stand-in for Rollup's TransformPluginContext, which the hook never touches.
			{} as never,
			code,
			id,
		);

		expect(result).toBeTruthy();
		const output = typeof result === "string" ? result : (result?.code ?? "");
		expect(output).not.toContain("@lingui/core/macro");
	});

	it("redirects locale catalog imports from admin source to dist/locales", () => {
		const importer = `${adminSourcePathPosix}/locales/loadMessages.ts`;

		const resolveId = unwrapHook(plugin.resolveId);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stand-in for Rollup's PluginContext, which the hook never touches.
		const resolved = resolveId.call({} as never, "./de/messages.mjs", importer, {
			attributes: {},
			isEntry: false,
		});

		expect(resolved).toBeTruthy();
		const resolvedPath = typeof resolved === "string" ? resolved : (resolved as { id: string })?.id;
		expect(resolvedPath).toContain(resolve(adminDistPath, "locales", "de", "messages.mjs"));
	});

	it("does not match files outside admin source", async () => {
		const id = `${adminDistPath}/index.js`;
		const code = 'import { t } from "@lingui/core/macro";';

		const transform = unwrapHook(plugin.transform);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stand-in for Rollup's TransformPluginContext, which the hook never touches.
		const result = await transform.call({} as never, code, id);

		expect(result).toBeFalsy();
	});
});
