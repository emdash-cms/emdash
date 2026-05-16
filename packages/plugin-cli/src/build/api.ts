/**
 * Programmatic plugin-build API.
 *
 * `emdash-plugin build` produces the on-disk distribution artifacts
 * for an npm-installed sandboxed plugin:
 *
 *   - `dist/plugin.mjs` (+ `dist/plugin.d.mts`) — runtime bytes (hooks +
 *     routes), built with `emdash` aliased to a no-op shim. The same
 *     artifact is consumed two ways at install time:
 *       1. In-process (`plugins: [...]`): the integration `import`s the
 *          package's `./sandbox` export and wraps the default with
 *          `adaptSandboxEntry`.
 *       2. Isolate (`sandboxed: [...]`): the integration resolves the
 *          same `./sandbox` export, reads the file's bytes, and
 *          string-embeds them into a generated module the sandbox
 *          runner loads.
 *   - `dist/manifest.json` — wire-shape `PluginManifest`. Same shape
 *     the registry bundle tarball carries; `bundle` packs this file
 *     verbatim (renaming `plugin.mjs` → `backend.js` inside the
 *     archive). Includes hooks + routes harvested from probing
 *     `src/plugin.ts`.
 *   - `dist/index.mjs` (+ `dist/index.d.mts`) — descriptor module,
 *     default-exporting the bare `PluginDescriptor`. Emitted only
 *     when a sibling `package.json` exists (registry-only plugins
 *     skip this because nothing would `import` it).
 *
 * The plugin author writes only `emdash-plugin.jsonc` + `src/plugin.ts`.
 * Identity (slug, publisher) and trust contract (capabilities,
 * allowedHosts, storage) come from the manifest; the version is either
 * in the manifest or in `package.json#version` (`normaliseManifest`
 * reconciles).
 *
 * Failures throw `BuildError` with a structured `code`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { PluginManifest, ResolvedPlugin } from "../bundle/types.js";
import { extractManifest } from "../bundle/utils.js";
import type { NormalisedManifest } from "../manifest/translate.js";
import {
	buildRuntime,
	probeAndAssemble,
	resolveSources,
	BuildPipelineError,
	type BuildPipelineErrorCode,
	type PipelineLogger,
	type ResolvedSources,
} from "./pipeline.js";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type BuildErrorCode = BuildPipelineErrorCode;

export class BuildError extends Error {
	override readonly name = "BuildError";
	readonly code: BuildErrorCode;

	constructor(code: BuildErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export type BuildLogger = PipelineLogger;

export interface BuildOptions {
	/** Plugin source directory, must contain `emdash-plugin.jsonc` + `src/plugin.ts`. */
	dir: string;
	/**
	 * Output directory for `dist/*`, relative to `dir` if not absolute.
	 * Defaults to `<dir>/dist`.
	 */
	outDir?: string;
	/** Optional progress reporter. */
	logger?: BuildLogger;
}

export interface BuildResult {
	/** The normalised source manifest (post-version-reconciliation). */
	manifest: NormalisedManifest;
	/** Package name from `package.json#name`, or `undefined` (registry-only plugin). */
	packageName: string | undefined;
	/**
	 * Wire-shape manifest written to `dist/manifest.json`. Includes
	 * hooks + routes harvested from probing `src/plugin.ts`. Bundle
	 * consumes this directly when packing the tarball.
	 */
	wireManifest: PluginManifest;
	/**
	 * The probed `ResolvedPlugin` — manifest identity + trust contract
	 * plus harvested hook/route handlers. Bundle uses this for its
	 * trusted-only / admin-route consistency checks without re-probing.
	 */
	resolvedPlugin: ResolvedPlugin;
	/** Absolute path of the dist directory. */
	outDir: string;
	/** Absolute paths of the files produced. */
	files: {
		runtime: string;
		runtimeTypes: string;
		manifestJson: string;
		/** Only set when `package.json` exists. */
		descriptor: string | undefined;
		/** Only set when `package.json` exists. */
		descriptorTypes: string | undefined;
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────────────────────────────────

export async function buildPlugin(options: BuildOptions): Promise<BuildResult> {
	const log = options.logger ?? {};
	const pluginDir = resolve(options.dir);
	const outDir = resolve(pluginDir, options.outDir ?? "dist");

	log.start?.("Building plugin...");

	let sources: ResolvedSources;
	try {
		sources = await resolveSources(pluginDir, log);
	} catch (error) {
		if (error instanceof BuildPipelineError) {
			throw new BuildError(error.code, error.message);
		}
		throw error;
	}

	const tmpDir = await mkdtemp(join(tmpdir(), "emdash-build-"));

	try {
		const { build } = await import("tsdown");

		await mkdir(outDir, { recursive: true });

		// ── 1. Build src/plugin.ts → dist/plugin.mjs (+ .d.mts) ──
		log.start?.("Building runtime entry...");
		const runtimeFiles = await runPipelineStep(() =>
			buildRuntime({
				entries: sources,
				outDir,
				tmpDir,
				build,
			}),
		);
		log.success?.("Built plugin.mjs");

		// ── 2. Probe src/plugin.ts for hooks + routes ──
		log.start?.("Probing plugin surface...");
		const resolvedPlugin = await runPipelineStep(() =>
			probeAndAssemble({
				entries: sources,
				tmpDir,
				build,
			}),
		);

		const wireManifest = extractManifest(resolvedPlugin);
		log.info?.(
			`  Hooks: ${
				wireManifest.hooks.length > 0
					? wireManifest.hooks.map((h) => (typeof h === "string" ? h : h.name)).join(", ")
					: "(none)"
			}`,
		);
		log.info?.(
			`  Routes: ${
				wireManifest.routes.length > 0
					? wireManifest.routes.map((r) => (typeof r === "string" ? r : r.name)).join(", ")
					: "(none)"
			}`,
		);

		// ── 3. Write dist/manifest.json (wire shape) ──
		const manifestJson = join(outDir, "manifest.json");
		await writeFile(manifestJson, `${JSON.stringify(wireManifest, null, 2)}\n`, "utf-8");
		log.success?.("Wrote manifest.json");

		// ── 4. Generate dist/index.mjs (+ .d.mts) — descriptor module ──
		// Only emitted when a sibling package.json exists. Registry-only
		// plugins (no package.json) can't be `pnpm add`-ed, so nothing
		// would `import` the descriptor module.
		let descriptor: string | undefined;
		let descriptorTypes: string | undefined;
		if (sources.hasPackageJson && sources.packageName) {
			log.start?.("Generating descriptor module...");
			({ descriptor, descriptorTypes } = await writeDescriptor({
				outDir,
				manifest: sources.manifest,
				packageName: sources.packageName,
			}));
			log.success?.("Wrote index.mjs");
		} else {
			log.info?.("No package.json — skipping dist/index.mjs (registry-only plugin)");
		}

		log.success?.(`Plugin built: ${sources.manifest.slug}@${sources.manifest.version}`);

		return {
			manifest: sources.manifest,
			packageName: sources.packageName,
			wireManifest,
			resolvedPlugin,
			outDir,
			files: {
				runtime: runtimeFiles.runtime,
				runtimeTypes: runtimeFiles.runtimeTypes,
				manifestJson,
				descriptor,
				descriptorTypes,
			},
		};
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Translate `BuildPipelineError` to `BuildError`. Other errors pass through.
 */
async function runPipelineStep<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof BuildPipelineError) {
			throw new BuildError(error.code, error.message);
		}
		throw error;
	}
}

interface WriteDescriptorContext {
	outDir: string;
	manifest: NormalisedManifest;
	packageName: string;
}

interface DescriptorFiles {
	descriptor: string;
	descriptorTypes: string;
}

/**
 * Emit `dist/index.mjs` + `dist/index.d.mts`.
 *
 * The descriptor is a frozen plain object — no factory call, no named
 * exports. Consumers write `import auditLog from "@.../plugin-audit-log"`
 * and pass `auditLog` into the integration's `plugins:` or `sandboxed:`
 * array directly. Per-install configuration moves to the admin UI's
 * settings (KV-backed) so the import shape has no need for a factory.
 *
 * The descriptor's `entrypoint` is `<package-name>/sandbox`. Plugins
 * MUST expose a `./sandbox` export in their `package.json` pointing at
 * `./dist/plugin.mjs` — the runtime bytes the integration loads.
 */
async function writeDescriptor(ctx: WriteDescriptorContext): Promise<DescriptorFiles> {
	const { outDir, manifest, packageName } = ctx;

	const descriptorObject = {
		id: manifest.slug,
		version: manifest.version,
		format: "standard" as const,
		entrypoint: `${packageName}/sandbox`,
		capabilities: manifest.capabilities,
		allowedHosts: manifest.allowedHosts,
		storage: manifest.storage,
		...(manifest.admin.pages.length > 0 ? { adminPages: manifest.admin.pages } : {}),
		...(manifest.admin.widgets.length > 0 ? { adminWidgets: manifest.admin.widgets } : {}),
	};

	// Pretty-print so the generated file is human-readable when debugging.
	// Tab-indent for consistency with the surrounding generated file's
	// surrounding tab-based formatting; matches the project's oxfmt config.
	const descriptorLiteral = JSON.stringify(descriptorObject, null, "\t");

	const descriptorSource = `// Auto-generated by emdash-plugin build. Do not edit.
// Source: emdash-plugin.jsonc + package.json
//
// Default-exports a sandboxed plugin descriptor. Pass it directly into
// emdash's \`plugins:\` or \`sandboxed:\` array — no factory call needed.

/** @type {import("emdash").PluginDescriptor} */
const descriptor = Object.freeze(${descriptorLiteral});

export default descriptor;
`;

	const descriptorPath = join(outDir, "index.mjs");
	await writeFile(descriptorPath, descriptorSource, "utf-8");

	const descriptorTypesSource = `// Auto-generated by emdash-plugin build. Do not edit.
import type { PluginDescriptor } from "emdash";

declare const descriptor: PluginDescriptor;
export default descriptor;
`;
	const descriptorTypesPath = join(outDir, "index.d.mts");
	await writeFile(descriptorTypesPath, descriptorTypesSource, "utf-8");

	return { descriptor: descriptorPath, descriptorTypes: descriptorTypesPath };
}
