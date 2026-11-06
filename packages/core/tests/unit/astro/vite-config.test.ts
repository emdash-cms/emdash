import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroConfig } from "astro";
import { build, createServer, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { generateBuildModule } from "../../../src/astro/integration/virtual-modules.js";
import {
	createViteConfig,
	linguiMacroPlugin,
	pathToImportUrl,
} from "../../../src/astro/integration/vite-config.js";
import { getRuntimeHolder, shutdownRuntime } from "../../../src/astro/runtime-holder.js";

// Vite/Rollup type hook fields as `T | { handler: T; order?: ... }`. This
// plugin always uses the plain-function form, so unwrap that shape to get a
// directly callable function without pulling in Rollup's types as a dependency.
function unwrapHook<T>(hook: T | { handler: T } | null | undefined): T {
	if (hook == null) throw new Error("Hook is not defined");
	if (typeof hook === "object" && "handler" in hook) return hook.handler;
	return hook;
}

function evaluateBuildModule(
	code: string,
	hot: { on: (event: string, listener: (payload: { triggeredBy?: string }) => unknown) => void },
) {
	const source = code
		.replaceAll("import.meta.hot", "hot")
		.replaceAll("export const ", "const ")
		.replaceAll("export function ", "function ");
	// eslint-disable-next-line no-new-func -- tests the generated virtual module in isolation.
	return new Function("hot", `${source}; return onBeforeFullReload;`)(hot) as (
		callback: () => unknown,
	) => void;
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

describe("createViteConfig Lingui singleton aliases", () => {
	const projectDir = mkdtempSync(join(tmpdir(), "emdash-lingui-resolver-"));
	const providerDir = join(projectDir, "node_modules", "provider");
	const adminRequire = createRequire(import.meta.url);
	const adminDistPath = dirname(adminRequire.resolve("@emdash-cms/admin"));
	const adminPackageRequire = createRequire(resolve(adminDistPath, "index.js"));
	const adminLinguiReactPath = dirname(adminPackageRequire.resolve("@lingui/react/package.json"));
	const adminLinguiCorePath = dirname(adminPackageRequire.resolve("@lingui/core/package.json"));

	beforeAll(() => {
		mkdirSync(providerDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), '{"private":true}');
		writeFileSync(join(providerDir, "index.js"), 'import "@lingui/react";\n');
		for (const packageName of ["react", "core"]) {
			const packageDir = join(providerDir, "node_modules", "@lingui", packageName);
			mkdirSync(packageDir, { recursive: true });
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({ name: `@lingui/${packageName}`, version: "secondary" }),
			);
			writeFileSync(join(packageDir, "index.js"), "export const secondary = true;\n");
		}
	});

	afterAll(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	for (const command of ["dev", "build"] as const) {
		it(`resolves Lingui imports to the admin copy in ${command} mode`, async () => {
			const config = createViteConfig(
				{
					serializableConfig: {},
					resolvedConfig: {} as never,
					pluginDescriptors: [],
					astroConfig: {
						root: pathToFileURL(`${projectDir}/`),
						adapter: { name: "@astrojs/node" },
					} as AstroConfig,
				},
				command,
			);
			const server = await createServer({
				root: projectDir,
				logLevel: "silent",
				resolve: config.resolve,
				optimizeDeps: { disabled: true },
			});

			try {
				const resolveFrom = async (specifier: string, importer: string) => {
					const result = await server.pluginContainer.resolveId(specifier, importer);
					if (!result) throw new Error(`Could not resolve ${specifier}`);
					return typeof result === "string" ? result : result.id;
				};
				const adminImporter = join(adminDistPath, "index.js");
				const providerImporter = join(providerDir, "index.js");

				const adminReact = await resolveFrom("@lingui/react", adminImporter);
				const providerReact = await resolveFrom("@lingui/react", providerImporter);
				const providerCoreMacro = await resolveFrom("@lingui/core/macro", providerImporter);

				expect(adminReact).toBe(providerReact);
				expect(adminReact).toContain(adminLinguiReactPath);
				expect(providerCoreMacro).toContain(adminLinguiCorePath);
				expect(providerCoreMacro).not.toContain(join(providerDir, "node_modules"));
			} finally {
				await server.close();
			}
		});
	}
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

	it.each([
		["use-sync-external-store/shim", "useSyncExternalStore"],
		["use-sync-external-store/shim/index.js", "useSyncExternalStore"],
		["use-sync-external-store/shim/with-selector", "useSyncExternalStoreWithSelector"],
		["use-sync-external-store/shim/with-selector.js", "useSyncExternalStoreWithSelector"],
	])("bundles default and named imports from %s", async (specifier, hook) => {
		const config = buildConfig("@astrojs/node");
		const entry = resolve("shim-consumer.js");

		await expect(
			build({
				configFile: false,
				logLevel: "silent",
				resolve: config.resolve,
				plugins: [
					{
						name: "shim-consumer",
						resolveId: (id) => (id === entry ? entry : null),
						load: (id) =>
							id === entry
								? `import hooks, { ${hook} } from "${specifier}";
export const named = ${hook};
export const fromDefault = hooks.${hook};`
								: null,
					},
				],
				build: {
					write: false,
					lib: { entry, formats: ["es"], fileName: "shim-consumer" },
					rollupOptions: { external: ["react"] },
				},
			}),
		).resolves.toBeDefined();
	});

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

describe("createViteConfig Cloudflare optimizer selection", () => {
	let fixtureRoot: string;
	beforeAll(() => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "emdash-vite-optimizer-"));
	});
	afterAll(() => {
		rmSync(fixtureRoot, { recursive: true, force: true });
	});
	function writeFixture({
		astroVersion,
		viteVersion,
		topLevelViteVersion,
	}: {
		astroVersion?: string;
		viteVersion?: string;
		topLevelViteVersion?: string;
	}) {
		const root = mkdtempSync(join(fixtureRoot, "site-"));
		mkdirSync(join(root, "node_modules", "astro"), { recursive: true });
		writeFileSync(join(root, "package.json"), '{"private":true}');
		if (astroVersion) {
			const astroDir = join(root, "node_modules", "astro");
			writeFileSync(
				join(astroDir, "package.json"),
				JSON.stringify({
					name: "astro",
					version: astroVersion,
					exports: { ".": "./index.js", "./package.json": "./package.json" },
				}),
			);
			writeFileSync(join(astroDir, "index.js"), "export {};\n");
			if (viteVersion) {
				const viteDir = join(astroDir, "node_modules", "vite");
				mkdirSync(viteDir, { recursive: true });
				writeFileSync(
					join(viteDir, "package.json"),
					JSON.stringify({ name: "vite", version: viteVersion }),
				);
			}
		}
		if (topLevelViteVersion) {
			const viteDir = join(root, "node_modules", "vite");
			mkdirSync(viteDir, { recursive: true });
			writeFileSync(
				join(viteDir, "package.json"),
				JSON.stringify({ name: "vite", version: topLevelViteVersion }),
			);
		}
		return pathToFileURL(`${root}/`);
	}
	function buildConfig(root: URL, resolvedConfig: Record<string, unknown> = {}) {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: resolvedConfig as never,
				pluginDescriptors: [],
				astroConfig: { root, adapter: { name: "@astrojs/cloudflare" } } as AstroConfig,
			},
			"dev",
		);
	}
	function isOptimized(config: ReturnType<typeof createViteConfig>) {
		const include = config.ssr?.optimizeDeps?.include ?? [];
		return (
			include.includes("emdash") &&
			(config.plugins ?? []).some(
				(plugin) =>
					typeof plugin === "object" &&
					plugin !== null &&
					"name" in plugin &&
					plugin.name === "emdash-cloudflare-optimizer-reload",
			)
		);
	}
	it.each([
		["Vite 7", "7.3.8", false],
		["Vite 8", "8.0.0", true],
		["missing Vite", undefined, false],
		["invalid Vite", "not-a-version", false],
	] as const)("uses Astro's nested Vite version for %s", (_name, viteVersion, optimized) => {
		const config = buildConfig(writeFixture({ astroVersion: "7.3.8", viteVersion }));
		expect(isOptimized(config)).toBe(optimized);
		const virtualPlugin = config.plugins?.find(
			(plugin): plugin is Plugin =>
				typeof plugin === "object" &&
				plugin !== null &&
				"name" in plugin &&
				plugin.name === "emdash-virtual-modules",
		);
		if (!virtualPlugin) throw new Error("Virtual modules plugin is missing");
		unwrapHook(virtualPlugin.configResolved)({ command: "serve" } as never);
		const buildModule = unwrapHook(virtualPlugin.load).call({} as never, "\0virtual:emdash/build");
		if (typeof buildModule !== "string") throw new Error("Build module is missing");
		const hot = { on: vi.fn() };
		evaluateBuildModule(buildModule, hot)(vi.fn());
		expect(hot.on).toHaveBeenCalledTimes(optimized ? 1 : 0);
		if (!optimized) {
			expect(config.ssr?.optimizeDeps?.exclude).toEqual(
				expect.arrayContaining(["emdash", "@emdash-cms/admin"]),
			);
			expect(config.ssr?.optimizeDeps?.include).not.toContain("emdash/middleware");
		}
	});
	it("does not use a conflicting top-level Vite instead of Astro's nested Vite", () => {
		expect(
			isOptimized(
				buildConfig(
					writeFixture({
						astroVersion: "7.3.8",
						viteVersion: "7.3.8",
						topLevelViteVersion: "8.0.0",
					}),
				),
			),
		).toBe(false);
		expect(
			isOptimized(
				buildConfig(
					writeFixture({
						astroVersion: "7.3.8",
						viteVersion: "8.0.0",
						topLevelViteVersion: "7.3.3",
					}),
				),
			),
		).toBe(true);
	});
	it("keeps source-mode Cloudflare development on HMR exclusions", () => {
		const config = buildConfig(new URL("../../../../../demos/cloudflare/", import.meta.url));
		const include = config.ssr?.optimizeDeps?.include ?? [];
		const exclude = config.ssr?.optimizeDeps?.exclude ?? [];
		expect(include).not.toContain("emdash");
		expect(include).not.toContain("@emdash-cms/admin");
		expect(exclude).toEqual(expect.arrayContaining(["emdash", "@emdash-cms/admin"]));
		expect(
			(config.plugins ?? []).some(
				(plugin) =>
					typeof plugin === "object" &&
					plugin !== null &&
					"name" in plugin &&
					plugin.name === "emdash-cloudflare-optimizer-reload",
			),
		).toBe(false);
	});
	it("only includes configured EmDash provider entrypoints", () => {
		const config = buildConfig(writeFixture({ astroVersion: "7.3.8", viteVersion: "8.0.0" }), {
			database: { entrypoint: "emdash/db/sqlite" },
			storage: { entrypoint: "@emdash-cms/cloudflare/storage/r2" },
			objectCache: { entrypoint: "emdash/internal/object-cache/memory" },
			mediaProviders: [
				{ entrypoint: "emdash/media" },
				{ entrypoint: "@emdash-cms/cloudflare/media" },
			],
		});
		const include = config.ssr?.optimizeDeps?.include ?? [];
		expect(include).toContain("emdash/db/sqlite");
		expect(include).toContain("emdash/internal/object-cache/memory");
		expect(include).toContain("emdash/media");
		expect(include).not.toContain("@emdash-cms/cloudflare/storage/r2");
		expect(include).not.toContain("@emdash-cms/cloudflare/media");
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

describe("createViteConfig runtime shutdown plugin", () => {
	const projectRoot = new URL("../../../../../demos/simple/", import.meta.url);

	function buildConfig(adapter: string, command: "dev" | "build" = "dev") {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: {} as never,
				pluginDescriptors: [],
				astroConfig: {
					root: projectRoot,
					adapter: { name: adapter },
				} as AstroConfig,
			},
			command,
		);
	}

	async function createViteTestServer(config: ReturnType<typeof createViteConfig>) {
		return createServer({
			configFile: false,
			logLevel: "silent",
			plugins: config.plugins,
			optimizeDeps: { disabled: true },
		});
	}

	it("shuts down and detaches the runtime before close resolves", async () => {
		const shutdown = vi.fn<() => Promise<void>>();
		let resolveShutdown!: () => void;
		shutdown.mockImplementation(
			() =>
				new Promise<void>((finish) => {
					resolveShutdown = finish;
				}),
		);
		const holder = getRuntimeHolder();
		holder.instance = { shutdown } as never;
		const server = await createViteTestServer(buildConfig("@astrojs/node"));

		try {
			const close = server.close();
			await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
			expect(getRuntimeHolder()).not.toBe(holder);
			expect(holder.instance).toBeNull();
			let closed = false;
			void close.then(() => {
				closed = true;
				return undefined;
			});
			await Promise.resolve();
			expect(closed).toBe(false);

			resolveShutdown();
			await close;
		} finally {
			resolveShutdown?.();
			await server.close().catch(() => undefined);
		}
		expect(shutdown).toHaveBeenCalledOnce();
	});

	it("does nothing when no runtime is held", async () => {
		const holder = getRuntimeHolder();
		holder.instance = null;
		const server = await createViteTestServer(buildConfig("@astrojs/node"));

		await expect(server.close()).resolves.toBeUndefined();
		expect(getRuntimeHolder()).not.toBe(holder);
	});

	it("detaches the runtime even when shutdown fails", async () => {
		const error = new Error("shutdown failed");
		const shutdown = vi.fn<() => Promise<void>>().mockRejectedValue(error);
		const holder = getRuntimeHolder();
		holder.instance = { shutdown } as never;
		const server = await createViteTestServer(buildConfig("@astrojs/node"));
		const logError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			// Vite settles close hooks even when a plugin rejects.
			await server.close();
			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(getRuntimeHolder()).not.toBe(holder);
			expect(holder.instance).toBeNull();
			expect(logError).toHaveBeenCalledWith("[emdash] runtime shutdown failed:", error);
		} finally {
			logError.mockRestore();
		}
	});

	it.each([
		["build", "@astrojs/node"],
		["dev on Cloudflare", "@astrojs/cloudflare"],
	] as const)("does not execute the shutdown plugin for %s", async (command, adapter) => {
		const shutdown = vi.fn<() => Promise<void>>();
		const holder = getRuntimeHolder();
		holder.instance = { shutdown } as never;
		const server = await createViteTestServer(
			buildConfig(adapter, command === "build" ? "build" : "dev"),
		);

		try {
			await server.close();
			expect(shutdown).not.toHaveBeenCalled();
			expect(getRuntimeHolder()).toBe(holder);
		} finally {
			holder.instance = null;
		}
	});
});

describe("generateBuildModule runtime reload lifecycle", () => {
	function register(
		reloadRuntime: boolean,
		hot: { on: (event: string, listener: (payload: { triggeredBy?: string }) => unknown) => void },
	) {
		return evaluateBuildModule(generateBuildModule(1, reloadRuntime), hot);
	}
	it("retains the runtime for a file reload and shuts it down for optimizer reload", async () => {
		const listeners = new Map<string, (payload: { triggeredBy?: string }) => unknown>();
		const hot = {
			on: (event: string, callback: (payload: { triggeredBy?: string }) => unknown) => {
				listeners.set(event, callback);
			},
		};
		let finishShutdown!: () => void;
		const shutdown = vi.fn(
			() =>
				new Promise<void>((finish) => {
					finishShutdown = finish;
				}),
		);
		const holder = getRuntimeHolder();
		holder.instance = { shutdown } as never;
		const pluginsKey = Symbol.for("emdash:plugins");
		Reflect.set(globalThis, pluginsKey, {});
		const onBeforeFullReload = register(true, hot);
		onBeforeFullReload(shutdownRuntime);
		const listener = listeners.get("vite:beforeFullReload");
		if (!listener) throw new Error("Full-reload listener was not registered");
		try {
			await listener({ triggeredBy: "file" });
			expect(getRuntimeHolder()).toBe(holder);
			expect(shutdown).not.toHaveBeenCalled();
			let finished = false;
			const reload = Promise.resolve(listener({})).then(() => {
				finished = true;
				return undefined;
			});
			await Promise.resolve();
			expect(finished).toBe(false);
			expect(shutdown).toHaveBeenCalledOnce();
			expect(getRuntimeHolder()).not.toBe(holder);
			expect(holder.instance).toBeNull();
			expect(Reflect.has(globalThis, pluginsKey)).toBe(false);
			finishShutdown();
			await reload;
			expect(finished).toBe(true);
		} finally {
			finishShutdown?.();
			holder.instance = null;
			Reflect.deleteProperty(globalThis, pluginsKey);
		}
	});
	it("allows the new graph to load even when runtime shutdown fails", async () => {
		let listener: ((payload: { triggeredBy?: string }) => unknown) | undefined;
		const hot = {
			on: (_event: string, callback: (payload: { triggeredBy?: string }) => unknown) => {
				listener = callback;
			},
		};
		const holder = getRuntimeHolder();
		const error = new Error("Sandbox teardown failed");
		holder.instance = {
			shutdown: async () => {
				throw error;
			},
		} as never;
		const logError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			register(true, hot)(shutdownRuntime);
			if (!listener) throw new Error("Full-reload listener was not registered");
			await expect(listener({})).resolves.toBeUndefined();
			expect(holder.instance).toBeNull();
			expect(getRuntimeHolder()).not.toBe(holder);
			expect(logError).toHaveBeenCalled();
		} finally {
			logError.mockRestore();
			holder.instance = null;
		}
	});
	it("does not register an HMR listener when runtime reload is disabled", () => {
		const hot = { on: vi.fn() };
		const onBeforeFullReload = register(false, hot);
		onBeforeFullReload(vi.fn());
		expect(hot.on).not.toHaveBeenCalled();
	});
});
