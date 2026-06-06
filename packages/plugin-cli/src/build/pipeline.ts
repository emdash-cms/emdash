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
import { pathToFileURL } from "node:url";

import type { ResolvedPlugin } from "../bundle/types.js";
import { fileExists } from "../bundle/utils.js";
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
import {
	ProbedDefaultSchema,
	type ProbedDefault,
	type ProbedHookEntry,
	type ProbedRouteEntry,
} from "./probe-schema.js";

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
		throw new BuildPipelineError("PACKAGE_JSON_INVALID", `${packageJsonPath} is not valid JSON.`);
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

	const pluginModule: unknown = await import(pathToFileURL(probeOutputPath).href);
	if (!isObjectRecord(pluginModule)) {
		throw new BuildPipelineError(
			"INVALID_PLUGIN_FORMAT",
			`${entries.pluginEntry} did not produce a module object on probe (got ${describeShape(pluginModule)}).`,
		);
	}
	if (pluginModule.default === undefined) {
		throw new BuildPipelineError(
			"INVALID_PLUGIN_FORMAT",
			`${entries.pluginEntry} has no \`default\` export. Sandboxed plugins must \`export default { hooks, routes } satisfies SandboxedPlugin\` from "emdash/plugin". A named-only export (e.g. \`export const plugin = ...\`) produces an empty bundle.`,
		);
	}
	const definition = pluginModule.default;
	if (!isObjectRecord(definition)) {
		throw new BuildPipelineError(
			"INVALID_PLUGIN_FORMAT",
			`${entries.pluginEntry} must default-export an object with \`hooks\` and/or \`routes\` (sandboxed plugin shape: \`export default { hooks, routes } satisfies SandboxedPlugin\` from "emdash/plugin"). Got ${describeShape(definition)}.`,
		);
	}

	const parsed = parseProbedDefault(entries.pluginEntry, definition);

	if (parsed.hooks) {
		for (const [hookName, hookEntry] of Object.entries(parsed.hooks)) {
			resolvedPlugin.hooks[hookName] = assembleHook(hookEntry, resolvedPlugin.id);
		}
	}
	if (parsed.routes) {
		for (const [routeName, routeEntry] of Object.entries(parsed.routes)) {
			resolvedPlugin.routes[routeName] = assembleRoute(routeEntry);
		}
	}

	return resolvedPlugin;
}

/**
 * Validate the probed default export against `ProbedDefaultSchema` and
 * translate any Zod issue into a `BuildPipelineError`. The first issue
 * wins so authors see one focused message rather than an issue tree.
 *
 * Path-keyed dispatch: an issue at `["hooks", "X"]` produces the
 * "must be a function or { handler, ... }" message; an issue at
 * `["hooks", "X", "field", ...]` produces the "has invalid FIELD VALUE"
 * message. Anything else falls back to a generic path-prefixed message.
 *
 * Exported so tests can lock in the error-message contract without
 * spinning up a real probe build.
 */
export function parseProbedDefault(pluginEntry: string, definition: unknown): ProbedDefault {
	let result: ReturnType<typeof ProbedDefaultSchema.safeParse>;
	try {
		result = ProbedDefaultSchema.safeParse(definition);
	} catch (error) {
		// Defensive: Zod 4 has been observed to throw `TypeError` when an
		// entry is an exotic shape it doesn't expect. The schema's
		// `normaliseEntry` preprocess catches the cases we know about,
		// but wrap `safeParse` so any future surprise still surfaces as a
		// `BuildPipelineError` rather than a raw stack trace.
		const message = error instanceof Error ? error.message : String(error);
		throw new BuildPipelineError(
			"INVALID_PLUGIN_FORMAT",
			`${pluginEntry}: probed default export could not be validated (${message}). Check for entries with unusual shapes (Promises, class instances, etc.).`,
		);
	}
	if (result.success) return result.data;

	const issue = result.error.issues[0];
	if (!issue) {
		throw new BuildPipelineError(
			"INVALID_PLUGIN_FORMAT",
			`${pluginEntry}: probed default export failed validation.`,
		);
	}

	const [collection, entryName, ...rest] = issue.path;
	if ((collection === "hooks" || collection === "routes") && typeof entryName === "string") {
		const kind = collection === "hooks" ? "hook" : "route";
		const entry = getProperty(getProperty(definition, collection), entryName);
		if (rest.length === 0) {
			throw new BuildPipelineError(
				"INVALID_PLUGIN_FORMAT",
				`${pluginEntry}: ${kind} "${entryName}" must be a function or { handler: function, ... }. Got ${describeShape(entry)}.`,
			);
		}
		// Per-field issue (errorPolicy, priority, timeout, dependencies,
		// public, …). The displayed value is the field as a whole, not
		// the deeper element the path points at; the Zod message
		// describes the actual fault.
		const field = formatFieldPath(rest);
		const fieldValue = typeof rest[0] === "string" ? getProperty(entry, rest[0]) : undefined;
		throw new BuildPipelineError(
			"INVALID_PLUGIN_FORMAT",
			`${pluginEntry}: ${kind} "${entryName}" has invalid ${field} ${safeStringify(fieldValue)} (${issue.message}).`,
		);
	}

	throw new BuildPipelineError(
		"INVALID_PLUGIN_FORMAT",
		`${pluginEntry}: ${issue.message} (at ${issue.path.join(".") || "<root>"}).`,
	);
}

/**
 * Render an issue path inside a hook/route entry as `field`,
 * `field[index]`, or `field.sub`. Used for human-readable error
 * messages only; never fed back into property lookups.
 */
function formatFieldPath(path: readonly PropertyKey[]): string {
	let out = "";
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`;
		} else if (out === "") {
			out += String(segment);
		} else {
			out += `.${String(segment)}`;
		}
	}
	return out || "<unknown>";
}

/**
 * Read a property off an `unknown` value, returning `undefined` for any
 * non-object input. Used only to recover the original user-supplied
 * value back off the definition for error-message formatting, never to
 * drive control flow. Exotic objects (Array, Map, Date, class
 * instances) return whatever the runtime gives them — harmless for
 * an error-message helper.
 */
function getProperty(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- error-message helper; widening to Record<string,unknown> for plain-object lookup is intentional, exotic objects return harmless results
	return (value as Record<string, unknown>)[key];
}

/**
 * `JSON.stringify` that survives values it can't serialise (`BigInt`,
 * cyclic structures, `undefined`, functions, symbols) by falling back
 * to `describeShape`. Used only to embed user-supplied values in
 * `BuildPipelineError` messages.
 */
function safeStringify(value: unknown): string {
	try {
		const json = JSON.stringify(value, (_key, v) =>
			typeof v === "bigint" ? `${v.toString()}n` : v,
		);
		// `JSON.stringify(undefined)` is `undefined` (not a string). Fall
		// through to the shape description in that case.
		if (json === undefined) return describeShape(value);
		return json;
	} catch {
		return describeShape(value);
	}
}

function assembleHook(entry: ProbedHookEntry, pluginId: string): ResolvedPlugin["hooks"][string] {
	// `preprocess` in `probe-schema.ts` normalises the bare-function form
	// into `{ handler }` before validation, so every entry that reaches
	// here is in the config form.
	return {
		handler: entry.handler,
		priority: entry.priority ?? 100,
		timeout: entry.timeout ?? 5000,
		dependencies: entry.dependencies ?? [],
		errorPolicy: entry.errorPolicy ?? "abort",
		exclusive: entry.exclusive ?? false,
		pluginId,
	};
}

function assembleRoute(entry: ProbedRouteEntry): ResolvedPlugin["routes"][string] {
	return { handler: entry.handler, public: entry.public };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function describeShape(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `array (length ${value.length})`;
	return typeof value;
}
