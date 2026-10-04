import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroConfig } from "astro";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createViteConfig,
	linguiMacroPlugin,
	pathToImportUrl,
} from "../../../src/astro/integration/vite-config.js";

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

describe("linguiMacroPlugin path handling", () => {
	const require = createRequire(import.meta.url);
	const adminDistPath = dirname(require.resolve("@emdash-cms/admin"));
	const macroCode = [
		'import { t } from "@lingui/core/macro";',
		"export const label = t`Hello`;",
	].join("\n");

	async function transform(adminSourcePath: string, id: string) {
		const plugin = linguiMacroPlugin(adminSourcePath, adminDistPath);
		const hook = unwrapHook(plugin.transform);
		const result = await hook.call(
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the hook does not use its Rollup context.
			{} as never,
			macroCode,
			id,
		);
		return typeof result === "string" ? result : (result?.code ?? "");
	}

	it("transforms macros for a Windows source path and Vite module id", async () => {
		const output = await transform(
			"C:\\workspace\\emdash\\packages\\admin\\src",
			"C:/workspace/emdash/packages/admin/src/components/Example.tsx",
		);

		expect(output).toContain("i18n._");
		expect(output).not.toContain("@lingui/core/macro");
	});

	it("keeps transforming POSIX Vite module ids", async () => {
		const output = await transform(
			"/workspace/emdash/packages/admin/src",
			"/workspace/emdash/packages/admin/src/components/Example.tsx",
		);

		expect(output).toContain("i18n._");
		expect(output).not.toContain("@lingui/core/macro");
	});

	it("converts drive-letter module paths to file URLs", () => {
		const url = new URL(
			pathToImportUrl("E:\\workspace\\emdash\\node_modules\\@babel\\core\\lib\\index.js"),
		);

		expect(url.protocol).toBe("file:");
		expect(url.pathname).toBe("/E:/workspace/emdash/node_modules/@babel/core/lib/index.js");
	});

	it("redirects locale catalog imports from a Windows Vite importer", () => {
		const plugin = linguiMacroPlugin("C:\\workspace\\emdash\\packages\\admin\\src", adminDistPath);
		const resolveId = unwrapHook(plugin.resolveId);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the hook does not use its Rollup context.
		const resolved = resolveId.call(
			{} as never,
			"./de/messages.mjs",
			"C:/workspace/emdash/packages/admin/src/locales/loadMessages.ts",
			{ attributes: {}, isEntry: false },
		);

		const resolvedPath = typeof resolved === "string" ? resolved : (resolved as { id: string })?.id;
		expect(resolvedPath).toBe(resolve(adminDistPath, "locales", "de", "messages.mjs"));
	});

	it("does not transform files outside admin source", async () => {
		const plugin = linguiMacroPlugin("C:\\workspace\\emdash\\packages\\admin\\src", adminDistPath);
		const hook = unwrapHook(plugin.transform);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the hook does not use its Rollup context.
		const result = await hook.call(
			{} as never,
			macroCode,
			"C:/workspace/emdash/packages/admin/dist/index.js",
		);

		expect(result).toBeFalsy();
	});
});

describe("createViteConfig inline Portable Text hydration deps", () => {
	const monorepoDemoRoot = new URL("../../../../../demos/simple/", import.meta.url);
	const externalProjectRoot = new URL("file:///workspace/emdash-site/");

	function buildConfig(root: URL) {
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
			"dev",
		);
	}

	it("pre-bundles lowlight and highlight.js in source-mode dev", () => {
		const config = buildConfig(monorepoDemoRoot);
		const include = config.optimizeDeps?.include ?? [];

		expect(include).toContain("emdash > lowlight");
		expect(include).toContain("emdash > highlight.js");
		expect(include).toContain("emdash > highlight.js/lib/core");
	});

	it("pre-bundles lowlight and highlight.js in external dist-mode dev", () => {
		const config = buildConfig(externalProjectRoot);
		const include = config.optimizeDeps?.include ?? [];

		expect(include).toContain("emdash > lowlight");
		expect(include).toContain("emdash > highlight.js");
		expect(include).toContain("emdash > highlight.js/lib/core");
	});
});

describe("createViteConfig Astro logger optimization", () => {
	const astroSevenRoot = new URL("../../../../../demos/cloudflare/", import.meta.url);
	let projectWithoutConsoleLoggerRoot: URL;
	let projectWithoutConsoleLoggerDir: string;

	beforeAll(() => {
		projectWithoutConsoleLoggerDir = mkdtempSync(join(tmpdir(), "emdash-astro-no-logger-"));
		const astroDir = join(projectWithoutConsoleLoggerDir, "node_modules", "astro");
		mkdirSync(astroDir, { recursive: true });
		writeFileSync(join(projectWithoutConsoleLoggerDir, "package.json"), '{"private":true}');
		writeFileSync(
			join(astroDir, "package.json"),
			'{"name":"astro","version":"6.0.0","exports":{".":"./index.js"}}',
		);
		writeFileSync(join(astroDir, "index.js"), "export {};\n");
		projectWithoutConsoleLoggerRoot = pathToFileURL(`${projectWithoutConsoleLoggerDir}/`);
	});

	afterAll(() => {
		rmSync(projectWithoutConsoleLoggerDir, { recursive: true, force: true });
	});

	function buildConfig(root: URL) {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: {} as never,
				pluginDescriptors: [],
				astroConfig: {
					root,
					adapter: { name: "@astrojs/cloudflare" },
				} as AstroConfig,
			},
			"dev",
		);
	}

	it("pre-bundles the public logger export for Astro 7", () => {
		const config = buildConfig(astroSevenRoot);

		expect(config.ssr?.optimizeDeps?.include).toContain("astro/logger/console");
	});

	it("does not require the logger when the project does not export it", () => {
		const config = buildConfig(projectWithoutConsoleLoggerRoot);

		expect(config.ssr?.optimizeDeps?.include).not.toContain("astro/logger/console");
	});
});
