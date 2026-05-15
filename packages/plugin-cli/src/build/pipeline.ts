/**
 * Shared build pipeline used by `build` and `bundle`.
 *
 * One canonical source-to-artifact pipeline so neither `build` nor `bundle`
 * has to maintain its own copy of the probe + transpile + extract logic.
 * `build` writes the dist artifacts to disk; `bundle` calls into the same
 * machinery to produce a `ResolvedPlugin` it then validates and tarballs.
 *
 * The phases:
 *
 *   1. `resolveSources(pluginDir)` — read + normalise `emdash-plugin.jsonc`,
 *      optionally read `package.json` for name/version, locate `src/plugin.ts`.
 *      Reconciles the manifest's optional `version` with `package.json#version`
 *      via `normaliseManifest` (mismatch / missing → error).
 *
 *   2. `probeAndAssemble({ entries, tmpDir })` — build `src/plugin.ts`
 *      unminified to a temp file, dynamically `import()` it, and harvest
 *      the hook/route surface into a `ResolvedPlugin`. Identity + trust
 *      contract come from the manifest, not the code.
 *
 *   3. `buildRuntime({ entries, outDir, tmpDir })` — build `src/plugin.ts`
 *      again, this time minified + tree-shaken + with `.d.mts` types, to
 *      produce `<outDir>/plugin.mjs` and `<outDir>/plugin.d.mts`. Probe
 *      and runtime builds differ deliberately in minification and dts
 *      output; the probe only reads `default.hooks` / `default.routes`
 *      *keys*, which minification doesn't rename (object literal keys
 *      stay stable). Both pass the same source through tsdown with no
 *      `external` and no `alias` — sandboxed plugins must not import
 *      from `emdash` at runtime (types come from `emdash/plugin` and
 *      are erased before bundling).
 *
 * Errors throw `BuildPipelineError` with a structured code. Wrappers translate
 * to their own error classes so the CLI's `BuildError` / `BundleError`
 * surfaces don't change.
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	ManifestError,
	MANIFEST_FILENAME,
	loadManifest,
	type LoadManifestResult,
} from "../manifest/load.js";
import {
	normaliseManifest,
	VersionMismatchError,
	type NormalisedManifest,
} from "../manifest/translate.js";
import type { ResolvedPlugin } from "../bundle/types.js";
import { fileExists } from "../bundle/utils.js";

const PLUGIN_ENTRY_PATH = "src/plugin.ts";
const PACKAGE_JSON_PATH = "package.json";

// ──────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────

export type BuildPipelineErrorCode =
	| "MISSING_MANIFEST"
	| "MISSING_PLUGIN_ENTRY"
	| "MANIFEST_INVALID"
	| "PACKAGE_JSON_INVALID"
	| "VERSION_MISMATCH"
	| "VERSION_MISSING"
	| "RUNTIME_BUILD_FAILED"
	| "PROBE_BUILD_FAILED"
	| "INVALID_PLUGIN_FORMAT";

export class BuildPipelineError extends Error {
	override readonly name = "BuildPipelineError";
	readonly code: BuildPipelineErrorCode;

	constructor(code: BuildPipelineErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Logger surface (shared by build + bundle wrappers)
// ──────────────────────────────────────────────────────────────────────────

export interface PipelineLogger {
	start?(message: string): void;
	info?(message: string): void;
	success?(message: string): void;
	warn?(message: string): void;
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 1: source resolution
// ──────────────────────────────────────────────────────────────────────────

export interface ResolvedSources {
	pluginDir: string;
	pluginEntry: string;
	manifest: NormalisedManifest;
	manifestPath: string;
	/**
	 * Package name from `package.json#name`, or `undefined` if no
	 * `package.json` exists (registry-only plugin).
	 */
	packageName: string | undefined;
	/**
	 * Whether a sibling `package.json` was found. Determines whether
	 * the descriptor module (`dist/index.mjs`) is emitted — a plugin
	 * without `package.json` can't be `pnpm add`-ed, so the descriptor
	 * has no consumer.
	 */
	hasPackageJson: boolean;
}

export async function resolveSources(
	pluginDir: string,
	log: PipelineLogger = {},
): Promise<ResolvedSources> {
	const resolvedDir = resolve(pluginDir);
	const manifestPath = join(resolvedDir, MANIFEST_FILENAME);

	if (!(await fileExists(manifestPath))) {
		throw new BuildPipelineError(
			"MISSING_MANIFEST",
			`No ${MANIFEST_FILENAME} found in ${resolvedDir}. Scaffold one with: emdash-plugin init`,
		);
	}

	let loaded: LoadManifestResult;
	try {
		loaded = await loadManifest(manifestPath);
	} catch (error) {
		if (error instanceof ManifestError) {
			throw new BuildPipelineError("MANIFEST_INVALID", error.message);
		}
		throw error;
	}

	const pluginEntry = join(resolvedDir, PLUGIN_ENTRY_PATH);
	if (!(await fileExists(pluginEntry))) {
		throw new BuildPipelineError(
			"MISSING_PLUGIN_ENTRY",
			`No ${PLUGIN_ENTRY_PATH} found in ${resolvedDir}. Sandboxed plugins place their routes and hooks in this single file.`,
		);
	}

	// `package.json` is optional. Common case (npm-distributed plugin):
	// present, drives the version and the descriptor's entrypoint
	// specifier. Edge case (registry-only plugin): absent, version
	// lives in the manifest, no descriptor module is emitted.
	const packageJsonPath = join(resolvedDir, PACKAGE_JSON_PATH);
	const hasPackageJson = await fileExists(packageJsonPath);
	let packageName: string | undefined;
	let packageVersion: string | undefined;
	if (hasPackageJson) {
		({ packageName, packageVersion } = await readPackageMeta(packageJsonPath));
	}

	let manifest: NormalisedManifest;
	try {
		manifest = normaliseManifest(loaded.manifest, packageVersion);
	} catch (error) {
		if (error instanceof VersionMismatchError) {
			throw new BuildPipelineError(error.code, error.message);
		}
		throw error;
	}

	log.info?.(`Manifest: ${loaded.path}`);
	log.info?.(`Plugin entry: ${pluginEntry}`);
	if (packageName) log.info?.(`Package: ${packageName}`);

	return {
		pluginDir: resolvedDir,
		pluginEntry,
		manifest,
		manifestPath: loaded.path,
		packageName,
		hasPackageJson,
	};
}

interface PackageMeta {
	packageName: string;
	packageVersion: string | undefined;
}

async function readPackageMeta(packageJsonPath: string): Promise<PackageMeta> {
	const source = await readFile(packageJsonPath, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new BuildPipelineError(
			"PACKAGE_JSON_INVALID",
			`${packageJsonPath} is not valid JSON.`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new BuildPipelineError(
			"PACKAGE_JSON_INVALID",
			`${packageJsonPath} must be a JSON object.`,
		);
	}
	const name = (parsed as { name?: unknown }).name;
	if (typeof name !== "string" || name.length === 0) {
		throw new BuildPipelineError(
			"PACKAGE_JSON_INVALID",
			`${packageJsonPath} has no "name" field. The build derives the runtime entrypoint specifier from package.json#name.`,
		);
	}
	// `version` is optional (registry-only plugins may rely on the
	// manifest's version); when present, it must be a non-empty
	// string.
	const versionRaw = (parsed as { version?: unknown }).version;
	let packageVersion: string | undefined;
	if (versionRaw === undefined) {
		packageVersion = undefined;
	} else if (typeof versionRaw === "string" && versionRaw.length > 0) {
		packageVersion = versionRaw;
	} else {
		throw new BuildPipelineError(
			"PACKAGE_JSON_INVALID",
			`${packageJsonPath} has a non-string or empty \`version\` (${JSON.stringify(versionRaw)}). Either remove the field (registry-only plugins) or set it to a non-empty string.`,
		);
	}
	return { packageName: name, packageVersion };
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2: probe + assemble
// ──────────────────────────────────────────────────────────────────────────

export interface ProbeAndAssembleContext {
	entries: ResolvedSources;
	tmpDir: string;
	build: typeof import("tsdown").build;
}

/**
 * Build `src/plugin.ts` once for hook/route probing, import it, and
 * assemble a `ResolvedPlugin` from the manifest's identity / trust
 * contract plus the probed surface.
 *
 * The probe build is *not* minified — keeping function bodies intact
 * makes the `pluginModule.default.hooks[x]` handler reads stable. The
 * later runtime build is minified separately by `buildRuntime`.
 */
export async function probeAndAssemble(ctx: ProbeAndAssembleContext): Promise<ResolvedPlugin> {
	const { entries, tmpDir, build } = ctx;

	const resolvedPlugin: ResolvedPlugin = {
		// `id` on the bundled manifest is the publisher's natural slug.
		// The runtime rewrites it to the opaque `r_<hash>` at install
		// time (see makeRegistryPluginId), but on-wire the slug is what
		// the install handler matches against the registry's record key.
		id: entries.manifest.slug,
		version: entries.manifest.version,
		capabilities: entries.manifest.capabilities,
		allowedHosts: entries.manifest.allowedHosts,
		storage: entries.manifest.storage,
		hooks: {},
		routes: {},
		admin: {
			pages: entries.manifest.admin.pages,
			widgets: entries.manifest.admin.widgets,
		},
	};

	const probeOutDir = join(tmpDir, "plugin-probe");

	try {
		await build({
			config: false,
			entry: { plugin: entries.pluginEntry },
			format: "esm",
			outExtensions: () => ({ js: ".mjs" }),
			outDir: probeOutDir,
			dts: false,
			platform: "neutral",
			external: [],
			treeshake: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new BuildPipelineError(
			"PROBE_BUILD_FAILED",
			`Failed to probe ${entries.pluginEntry}: ${message}`,
		);
	}

	const probeOutputPath = join(probeOutDir, "plugin.mjs");
	if (!(await fileExists(probeOutputPath))) {
		throw new BuildPipelineError(
			"PROBE_BUILD_FAILED",
			`Probe of ${entries.pluginEntry} produced no output at ${probeOutputPath}.`,
		);
	}

	const pluginModule = (await import(probeOutputPath)) as Record<string, unknown>;
	const definition = (pluginModule.default ?? {}) as Record<string, unknown>;
	if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
		throw new BuildPipelineError(
			"INVALID_PLUGIN_FORMAT",
			`${entries.pluginEntry} must default-export an object with \`hooks\` and/or \`routes\` (sandboxed plugin shape: \`export default { hooks, routes } satisfies SandboxedPlugin\` from "emdash/plugin"). Got ${describeShape(definition)}.`,
		);
	}

	const hooks = definition.hooks as Record<string, unknown> | undefined;
	const routes = definition.routes as Record<string, unknown> | undefined;

	if (hooks) {
		for (const hookName of Object.keys(hooks)) {
			const hookEntry = hooks[hookName];
			const handler = extractHookHandler(hookEntry);
			if (!handler) {
				throw new BuildPipelineError(
					"INVALID_PLUGIN_FORMAT",
					`${entries.pluginEntry}: hook "${hookName}" must be a function or { handler: function, ... }. Got ${describeShape(hookEntry)}.`,
				);
			}
			const config: Record<string, unknown> =
				typeof hookEntry === "object" && hookEntry !== null
					? (hookEntry as Record<string, unknown>)
					: {};
			// Re-validate hook config values at build time. The strict
			// `SandboxedPlugin` type rejects these at compile time;
			// this catches authors who bypass typecheck (untyped JS,
			// dynamic config).
			if (
				config.errorPolicy !== undefined &&
				config.errorPolicy !== "continue" &&
				config.errorPolicy !== "abort"
			) {
				throw new BuildPipelineError(
					"INVALID_PLUGIN_FORMAT",
					`${entries.pluginEntry}: hook "${hookName}" has invalid errorPolicy ${JSON.stringify(config.errorPolicy)} (must be "continue" or "abort").`,
				);
			}
			if (
				config.priority !== undefined &&
				(typeof config.priority !== "number" || !Number.isFinite(config.priority))
			) {
				throw new BuildPipelineError(
					"INVALID_PLUGIN_FORMAT",
					`${entries.pluginEntry}: hook "${hookName}" has invalid priority ${JSON.stringify(config.priority)} (must be a finite number).`,
				);
			}
			if (
				config.timeout !== undefined &&
				(typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout < 0)
			) {
				throw new BuildPipelineError(
					"INVALID_PLUGIN_FORMAT",
					`${entries.pluginEntry}: hook "${hookName}" has invalid timeout ${JSON.stringify(config.timeout)} (must be a non-negative finite number).`,
				);
			}
			resolvedPlugin.hooks[hookName] = {
				handler,
				priority: (config.priority as number | undefined) ?? 100,
				timeout: (config.timeout as number | undefined) ?? 5000,
				dependencies: (config.dependencies as string[] | undefined) ?? [],
				errorPolicy: (config.errorPolicy as string | undefined) ?? "abort",
				exclusive: (config.exclusive as boolean | undefined) ?? false,
				pluginId: resolvedPlugin.id,
			};
		}
	}
	if (routes) {
		for (const [name, route] of Object.entries(routes)) {
			const handler = extractRouteHandler(route);
			if (!handler) {
				throw new BuildPipelineError(
					"INVALID_PLUGIN_FORMAT",
					`${entries.pluginEntry}: route "${name}" must be a function or { handler: function, ... }. Got ${describeShape(route)}.`,
				);
			}
			const routeObj: Record<string, unknown> =
				typeof route === "object" && route !== null ? (route as Record<string, unknown>) : {};
			resolvedPlugin.routes[name] = {
				handler,
				public: routeObj.public as boolean | undefined,
			};
		}
	}

	return resolvedPlugin;
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 3: runtime build
// ──────────────────────────────────────────────────────────────────────────

export interface BuildRuntimeContext {
	entries: ResolvedSources;
	outDir: string;
	tmpDir: string;
	build: typeof import("tsdown").build;
}

export interface RuntimeFiles {
	runtime: string;
	runtimeTypes: string;
}

/**
 * Build `src/plugin.ts` into `<outDir>/plugin.mjs` + `<outDir>/plugin.d.mts`.
 *
 * Same source as the probe; the configuration differs only in
 * `minify: true` and `dts: true`. The probe stays unminified for
 * stable property-key reads (`default.hooks`, `default.routes`); the
 * runtime build minifies because this output is what runs in the
 * isolate (loader string-embeds it) or is `import`-ed in-process. No
 * `external`, no `alias` — sandboxed plugins must not import from
 * `emdash` at runtime.
 */
export async function buildRuntime(ctx: BuildRuntimeContext): Promise<RuntimeFiles> {
	const { entries, outDir, tmpDir, build } = ctx;

	const runtimeOutDir = join(tmpDir, "runtime");

	try {
		await build({
			config: false,
			entry: { plugin: entries.pluginEntry },
			format: "esm",
			outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
			outDir: runtimeOutDir,
			dts: true,
			platform: "neutral",
			external: [],
			minify: true,
			treeshake: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new BuildPipelineError(
			"RUNTIME_BUILD_FAILED",
			`Failed to build ${entries.pluginEntry}: ${message}`,
		);
	}

	const builtJs = join(runtimeOutDir, "plugin.mjs");
	if (!(await fileExists(builtJs))) {
		throw new BuildPipelineError(
			"RUNTIME_BUILD_FAILED",
			`Runtime build produced no plugin.mjs output for ${entries.pluginEntry}.`,
		);
	}
	await mkdir(outDir, { recursive: true });
	const runtime = join(outDir, "plugin.mjs");
	await copyFile(builtJs, runtime);

	const builtDts = join(runtimeOutDir, "plugin.d.mts");
	const runtimeTypes = join(outDir, "plugin.d.mts");
	if (await fileExists(builtDts)) {
		await copyFile(builtDts, runtimeTypes);
	}

	return { runtime, runtimeTypes };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function extractHookHandler(entry: unknown): unknown {
	if (typeof entry === "function") return entry;
	if (entry && typeof entry === "object" && "handler" in entry) {
		const handler = (entry as { handler: unknown }).handler;
		if (typeof handler === "function") return handler;
	}
	return undefined;
}

function extractRouteHandler(entry: unknown): unknown {
	if (typeof entry === "function") return entry;
	if (entry && typeof entry === "object" && "handler" in entry) {
		const handler = (entry as { handler: unknown }).handler;
		if (typeof handler === "function") return handler;
	}
	return undefined;
}

function describeShape(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `array (length ${value.length})`;
	return typeof value;
}
