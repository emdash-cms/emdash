/**
 * Programmatic plugin-bundling API.
 *
 * Pure-ish core of the bundling pipeline -- no `process.exit`, no console
 * output. The CLI in `./command.ts` is a thin wrapper that turns these calls
 * into pretty terminal output; tests exercise this module directly.
 *
 * The bundling steps:
 *
 *   1. Read `emdash-plugin.jsonc` via the manifest loader: identity (slug,
 *      version), trust contract (capabilities, allowedHosts, storage), and
 *      the rest of the profile fields.
 *   2. Build `src/plugin.ts` as a probe to capture hook/route names that
 *      go into the bundled `manifest.json`.
 *   3. Build `src/plugin.ts` again as the final `backend.js` (minified,
 *      with `emdash` aliased to a no-op shim that exposes only
 *      `definePlugin`).
 *   4. Write `manifest.json` from the manifest fields + probed surface,
 *      and copy assets (README, icon, screenshots).
 *   5. Validate (size limits, no Node builtins, no source exports, admin
 *      route consistency, sandbox-incompatible features).
 *   6. Create the gzipped tarball and return its checksum.
 *
 * Failures throw `BundleError` with a structured `code` so callers can
 * branch (CLI shows a helpful message; tests assert the code).
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import {
	ManifestError,
	MANIFEST_FILENAME,
	loadManifest,
	type LoadManifestResult,
} from "../manifest/load.js";
import { normaliseManifest, type NormalisedManifest } from "../manifest/translate.js";
import {
	CAPABILITY_RENAMES,
	isDeprecatedCapability,
	type PluginManifest,
	type ResolvedPlugin,
} from "./types.js";
import {
	collectBundleEntries,
	createTarball,
	extractManifest,
	fileExists,
	findBuildOutput,
	findNodeBuiltinImports,
	formatBytes,
	ICON_SIZE,
	MAX_SCREENSHOTS,
	MAX_SCREENSHOT_HEIGHT,
	MAX_SCREENSHOT_WIDTH,
	readImageDimensions,
	totalBundleBytes,
	validateBundleSize,
} from "./utils.js";

const TS_EXT_RE = /\.(tsx?|[mc]?js)$/;
const SLASH_RE = /\//g;
const LEADING_AT_RE = /^@/;

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type BundleErrorCode =
	| "MISSING_MANIFEST"
	| "MISSING_PLUGIN_ENTRY"
	| "MANIFEST_INVALID"
	| "INVALID_PLUGIN_FORMAT"
	| "TRUSTED_ONLY_FEATURE"
	| "BACKEND_BUILD_FAILED"
	| "VALIDATION_FAILED";

export class BundleError extends Error {
	readonly code: BundleErrorCode;

	constructor(code: BundleErrorCode, message: string) {
		super(message);
		this.name = "BundleError";
		this.code = code;
	}
}

export interface BundleLogger {
	start?(message: string): void;
	info?(message: string): void;
	success?(message: string): void;
	warn?(message: string): void;
}

export interface BundleOptions {
	/** Plugin source directory, must contain a `package.json`. */
	dir: string;
	/**
	 * Output directory for the tarball, relative to `dir` if not absolute.
	 * Defaults to `<dir>/dist`.
	 */
	outDir?: string;
	/**
	 * Skip tarball creation; only run the build + validation. Useful for
	 * pre-publish checks. Default: `false`.
	 */
	validateOnly?: boolean;
	/**
	 * Optional progress reporter. The CLI passes a consola-shaped adapter;
	 * tests typically pass `undefined` or a recording stub.
	 */
	logger?: BundleLogger;
}

export interface BundleResult {
	/** The extracted plugin manifest (also written to manifest.json). */
	manifest: PluginManifest;
	/** Absolute path to the resulting tarball, or `null` when `validateOnly`. */
	tarballPath: string | null;
	/** Tarball size in bytes, or `null` when `validateOnly`. */
	tarballBytes: number | null;
	/** Hex sha256 of the tarball contents, or `null` when `validateOnly`. */
	sha256: string | null;
	/** Non-fatal warnings collected during validation (deprecated caps, etc.). */
	warnings: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Conventional source-file paths the bundler looks for. The redesign
 * pins these instead of consulting `package.json` exports — a sandboxed
 * plugin has exactly one runtime entry, and the manifest provides
 * identity. Anything beyond these conventions is the author's
 * responsibility (e.g. typecheck against their own tsconfig).
 */
const PLUGIN_ENTRY_PATH = "src/plugin.ts";

interface ResolvedEntries {
	/**
	 * Absolute path to `src/plugin.ts`. The single source file the
	 * bundler probes (for hook/route names) and builds (as backend.js).
	 */
	pluginEntry: string;
	/** The validated manifest, used as the source of truth for identity + trust contract. */
	manifest: NormalisedManifest;
	/** Resolved path of the loaded `emdash-plugin.jsonc`, kept for diagnostics. */
	manifestPath: string;
}

export async function bundlePlugin(options: BundleOptions): Promise<BundleResult> {
	const log = options.logger ?? {};
	const pluginDir = resolve(options.dir);
	const outDir = resolve(pluginDir, options.outDir ?? "dist");
	const validateOnly = options.validateOnly ?? false;
	const warnings: string[] = [];
	const warn = (msg: string) => {
		warnings.push(msg);
		log.warn?.(msg);
	};

	log.start?.(validateOnly ? "Validating plugin..." : "Bundling plugin...");

	// ── 1. Read manifest + locate plugin entry ──
	const entries = await resolveEntries(pluginDir, log);

	// ── 2. Assemble ResolvedPlugin from manifest + probe ──
	log.start?.("Extracting plugin manifest...");

	// Each invocation gets its own tmpdir under the OS tmp root so concurrent
	// `bundlePlugin` runs (CI + local dev, watch-mode + manual) don't trample
	// each other's intermediate artefacts. Cleaned up unconditionally in the
	// `finally` below.
	const tmpDir = await mkdtemp(join(tmpdir(), "emdash-bundle-"));

	try {
		// Dynamic-import tsdown INSIDE the try block so a missing/broken
		// tsdown install (or a transient ENOENT during import) doesn't leak
		// the tmpdir we just created. The cost is one extra try-frame; the
		// alternative was a tmpdir orphaned per failed import.
		const { build } = await import("tsdown");

		const resolvedPlugin = await assembleResolvedPlugin({
			tmpDir,
			entries,
			build,
		});

		const manifest = extractManifest(resolvedPlugin);

		log.success?.(`Plugin: ${manifest.id}@${manifest.version}`);
		log.info?.(
			`  Capabilities: ${manifest.capabilities.length > 0 ? manifest.capabilities.join(", ") : "(none)"}`,
		);
		log.info?.(
			`  Hooks: ${manifest.hooks.length > 0 ? manifest.hooks.map((h) => (typeof h === "string" ? h : h.name)).join(", ") : "(none)"}`,
		);
		log.info?.(
			`  Routes: ${manifest.routes.length > 0 ? manifest.routes.map((r) => (typeof r === "string" ? r : r.name)).join(", ") : "(none)"}`,
		);

		// ── 3. Bundle backend.js ──
		const bundleDir = join(tmpDir, "bundle");
		await mkdir(bundleDir, { recursive: true });

		{
			log.start?.("Bundling backend...");
			const shimPath = await writeEmdashShim(join(tmpDir, "shims"));

			await build({
				config: false,
				entry: [entries.pluginEntry],
				format: "esm",
				outDir: join(tmpDir, "backend"),
				dts: false,
				platform: "neutral",
				external: [],
				alias: { emdash: shimPath },
				minify: true,
				treeshake: true,
			});

			const backendBaseName = basename(entries.pluginEntry).replace(TS_EXT_RE, "");
			const backendOutputPath = await findBuildOutput(join(tmpDir, "backend"), backendBaseName);
			if (!backendOutputPath) {
				throw new BundleError("BACKEND_BUILD_FAILED", "Backend build produced no output");
			}
			await copyFile(backendOutputPath, join(bundleDir, "backend.js"));
			log.success?.("Built backend.js");
		}

		// ── 4. Write manifest.json ──
		await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));

		// ── 5. Collect assets ──
		log.start?.("Collecting assets...");
		await collectAssets({ pluginDir, bundleDir, log, warn });

		// ── 6. Validate ──
		log.start?.("Validating bundle...");
		const validationErrors: string[] = [];

		// Node builtins in backend.js -> hard fail.
		const backendPath = join(bundleDir, "backend.js");
		if (await fileExists(backendPath)) {
			const backendCode = await readFile(backendPath, "utf-8");
			const builtins = findNodeBuiltinImports(backendCode);
			if (builtins.length > 0) {
				validationErrors.push(
					`backend.js imports Node.js built-in modules: ${builtins.join(", ")}. Sandboxed plugins cannot use Node.js APIs.`,
				);
			}
		}

		// Capability sanity warnings.
		const declaresUnrestricted =
			manifest.capabilities.includes("network:request:unrestricted") ||
			manifest.capabilities.includes("network:fetch:any");
		const declaresHostRestricted =
			manifest.capabilities.includes("network:request") ||
			manifest.capabilities.includes("network:fetch");
		if (declaresUnrestricted) {
			warn(
				"Plugin declares unrestricted network access (network:request:unrestricted) — it can make requests to any host.",
			);
		} else if (declaresHostRestricted && manifest.allowedHosts.length === 0) {
			// `publish` will hard-fail this case (INVALID_MANIFEST) because
			// the lexicon says `request: {}` means "unrestricted" -- silently
			// publishing that contradicts the apparent intent of declaring
			// `network:request` (host-restricted) with empty allowedHosts.
			// Surface it loudly at bundle time so the developer fixes it
			// before they try to publish.
			warn(
				"Plugin declares network:request capability but no allowedHosts. The lexicon treats this as `unrestricted` access. Add specific host patterns to allowedHosts, or upgrade the capability to network:request:unrestricted. `publish` will refuse this combination.",
			);
		}

		// Deprecated capabilities are warnings here; `publish` hard-fails on them.
		const deprecatedCaps = manifest.capabilities.filter(isDeprecatedCapability);
		if (deprecatedCaps.length > 0) {
			warn("Plugin uses deprecated capability names. Rename them before publishing:");
			for (const cap of deprecatedCaps) {
				warn(`  ${cap} -> ${CAPABILITY_RENAMES[cap]}`);
			}
		}

		// Trusted-only features that won't work in sandboxed mode.
		if (
			resolvedPlugin.admin?.portableTextBlocks &&
			resolvedPlugin.admin.portableTextBlocks.length > 0
		) {
			warn(
				"Plugin declares portableTextBlocks — these require trusted mode and will be ignored in sandboxed plugins.",
			);
		}
		if (resolvedPlugin.admin?.entry) {
			warn(
				"Plugin declares admin.entry — custom React components require trusted mode. Use Block Kit for sandboxed admin pages.",
			);
		}
		if (resolvedPlugin.hooks["page:fragments"]) {
			warn(
				"Plugin declares page:fragments hook — this is trusted-only and will not work in sandboxed mode.",
			);
		}

		// Admin pages/widgets require an `admin` route.
		const hasAdminPages = (manifest.admin?.pages?.length ?? 0) > 0;
		const hasAdminWidgets = (manifest.admin?.widgets?.length ?? 0) > 0;
		if (hasAdminPages || hasAdminWidgets) {
			const routeNames = manifest.routes.map((r) => (typeof r === "string" ? r : r.name));
			if (!routeNames.includes("admin")) {
				const declared =
					hasAdminPages && hasAdminWidgets
						? "adminPages and adminWidgets"
						: hasAdminPages
							? "adminPages"
							: "adminWidgets";
				validationErrors.push(
					`Plugin declares ${declared} but the sandbox entry has no "admin" route. Add an admin route handler to serve Block Kit pages.`,
				);
			}
		}

		// Bundle size caps (RFC 0001 §"Bundle size limits").
		const bundleEntries = await collectBundleEntries(bundleDir);
		const sizeViolations = validateBundleSize(bundleEntries);
		if (sizeViolations.length > 0) {
			validationErrors.push(...sizeViolations);
		} else {
			log.info?.(
				`Bundle size: ${formatBytes(totalBundleBytes(bundleEntries))} across ${bundleEntries.length} file${bundleEntries.length === 1 ? "" : "s"}`,
			);
		}

		if (validationErrors.length > 0) {
			throw new BundleError(
				"VALIDATION_FAILED",
				`Bundle validation failed:\n  - ${validationErrors.join("\n  - ")}`,
			);
		}

		log.success?.("Validation passed");

		// ── 8. Create tarball (or stop here if validateOnly) ──
		if (validateOnly) {
			return {
				manifest,
				tarballPath: null,
				tarballBytes: null,
				sha256: null,
				warnings,
			};
		}

		await mkdir(outDir, { recursive: true });
		const tarballName = `${manifest.id.replace(SLASH_RE, "-").replace(LEADING_AT_RE, "")}-${manifest.version}.tar.gz`;
		const tarballPath = join(outDir, tarballName);

		log.start?.("Creating tarball...");
		await createTarball(bundleDir, tarballPath);

		const tarballStat = await stat(tarballPath);
		const tarballBuf = await readFile(tarballPath);
		const sha256 = createHash("sha256").update(tarballBuf).digest("hex");

		log.success?.(`Created ${tarballName} (${(tarballStat.size / 1024).toFixed(1)}KB)`);
		log.info?.(`  SHA-256: ${sha256}`);
		log.info?.(`  Path: ${tarballPath}`);

		return {
			manifest,
			tarballPath,
			tarballBytes: tarballStat.size,
			sha256,
			warnings,
		};
	} finally {
		// Always clean up. mkdtemp produced this dir for us, so there's no
		// chance of nuking something the user expected to keep.
		await rm(tmpDir, { recursive: true, force: true });
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read the manifest and locate the plugin's runtime entry. The redesign
 * pins both to conventional locations:
 *
 *   - `<dir>/emdash-plugin.jsonc` — identity + trust contract + profile
 *     fields. Parsed and validated by the same loader the CLI's
 *     `validate` command uses, so error messages are consistent.
 *   - `<dir>/src/plugin.ts` — the runtime code (routes + hooks via
 *     `definePlugin`). Single source file; no `package.json` exports
 *     consulted.
 *
 * `package.json` is not read here at all. It's still present in the
 * plugin directory because Node tooling needs it (vitest, tsc), but
 * the bundler doesn't care about its `name`, `version`, `main`, or
 * `exports` fields — those would just be ways to disagree with the
 * manifest.
 */
async function resolveEntries(pluginDir: string, log: BundleLogger): Promise<ResolvedEntries> {
	const manifestPath = join(pluginDir, MANIFEST_FILENAME);
	if (!(await fileExists(manifestPath))) {
		throw new BundleError(
			"MISSING_MANIFEST",
			`No ${MANIFEST_FILENAME} found in ${pluginDir}. Create one with: emdash-registry init`,
		);
	}

	let loaded: LoadManifestResult;
	try {
		loaded = await loadManifest(manifestPath);
	} catch (error) {
		if (error instanceof ManifestError) {
			throw new BundleError("MANIFEST_INVALID", error.message);
		}
		throw error;
	}
	const manifest = normaliseManifest(loaded.manifest);

	const pluginEntry = join(pluginDir, PLUGIN_ENTRY_PATH);
	if (!(await fileExists(pluginEntry))) {
		throw new BundleError(
			"MISSING_PLUGIN_ENTRY",
			`No ${PLUGIN_ENTRY_PATH} found in ${pluginDir}. Sandboxed plugins place their routes and hooks in this single file (see emdash-registry init for the canonical layout).`,
		);
	}

	log.info?.(`Manifest: ${loaded.path}`);
	log.info?.(`Plugin entry: ${pluginEntry}`);

	return { pluginEntry, manifest, manifestPath: loaded.path };
}

interface AssembleContext {
	tmpDir: string;
	entries: ResolvedEntries;
	build: typeof import("tsdown").build;
}

/**
 * Assemble a `ResolvedPlugin` from the manifest (identity + trust contract)
 * and a probe of `src/plugin.ts` (hook/route surface).
 *
 * The redesign collapses what used to be two distinct steps — main-entry
 * descriptor extraction and sandbox-entry probe — into a single probe.
 * Identity isn't authored in code anymore; the manifest is the source of
 * truth, validated upstream by `loadManifest`.
 */
async function assembleResolvedPlugin(ctx: AssembleContext): Promise<ResolvedPlugin> {
	const { tmpDir, entries, build } = ctx;

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
			// Pages / widgets the plugin declared in the manifest get
			// passed straight through to the bundled `manifest.json`.
			// `extractManifest` reads from `admin` to populate the
			// `admin` block of the wire format.
			pages: entries.manifest.admin.pages,
			widgets: entries.manifest.admin.widgets,
		},
	};

	await probePluginSurface({
		resolvedPlugin,
		pluginEntry: entries.pluginEntry,
		tmpDir,
		build,
	});

	return resolvedPlugin;
}

/**
 * Write a stub `emdash.mjs` into `dir` that the user's plugin code resolves
 * its `import "emdash"` against during build/probe. The shim's surface is:
 *
 *   - `definePlugin` (named + default-property): identity function. The
 *     standard format's only legal `emdash` import.
 *   - default export: a Proxy. Any property access other than
 *     `definePlugin` returns a function that throws on call with a clear
 *     message. Without the Proxy, plugins doing dynamic property access on
 *     the default would silently get undefined and tree-shake to nothing.
 *
 * Named imports of anything other than `definePlugin` (e.g.
 * `import { admin } from "emdash"`) are caught by the bundler at build
 * time -- the named binding doesn't exist on the shim, so tsdown / Rollup
 * errors with "Module 'emdash' has no exported member 'admin'". That's a
 * better failure mode than a runtime undefined, so we don't try to handle
 * unknown named imports at the shim level.
 */
async function writeEmdashShim(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "emdash.mjs");
	const source = `export const definePlugin = (d) => d;
const NOT_AVAILABLE = (name) => () => {
  throw new Error(
    \`Sandboxed plugins must not import "\${name}" from "emdash". Only \\\`definePlugin\\\` is available in standard format.\`
  );
};
const handler = {
  get(target, prop, receiver) {
    if (prop === "definePlugin") return target.definePlugin;
    if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
    return NOT_AVAILABLE(prop);
  },
};
export default new Proxy({ definePlugin }, handler);
`;
	await writeFile(path, source);
	return path;
}

interface ProbeContext {
	resolvedPlugin: ResolvedPlugin;
	pluginEntry: string;
	tmpDir: string;
	build: typeof import("tsdown").build;
}

/**
 * Build `src/plugin.ts` with `emdash` aliased to the no-op shim (which
 * only exports `definePlugin`), then import it to read its default
 * export's `hooks` and `routes` shape. The handler functions are
 * recorded on the `ResolvedPlugin` even though `extractManifest` will
 * strip them — they prove the surface is callable, and the probe build
 * surfaces any compile-time error in the plugin code before we bother
 * with the real backend build.
 */
async function probePluginSurface(ctx: ProbeContext): Promise<void> {
	const { resolvedPlugin, pluginEntry, tmpDir, build } = ctx;
	const probeOutDir = join(tmpDir, "plugin-probe");
	const probeShimPath = await writeEmdashShim(join(tmpDir, "probe-shims"));
	await build({
		config: false,
		entry: [pluginEntry],
		format: "esm",
		outDir: probeOutDir,
		dts: false,
		platform: "neutral",
		external: [],
		alias: { emdash: probeShimPath },
		treeshake: true,
	});
	const probeBaseName = basename(pluginEntry).replace(TS_EXT_RE, "");
	const probeOutputPath = await findBuildOutput(probeOutDir, probeBaseName);
	if (!probeOutputPath) {
		throw new BundleError(
			"BACKEND_BUILD_FAILED",
			`Failed to build ${pluginEntry} for probe — no output found in ${probeOutDir}`,
		);
	}

	const pluginModule = (await import(probeOutputPath)) as Record<string, unknown>;
	const definition = (pluginModule.default ?? {}) as Record<string, unknown>;
	if (typeof definition !== "object" || definition === null) {
		throw new BundleError(
			"INVALID_PLUGIN_FORMAT",
			`${pluginEntry} must default-export the result of definePlugin({ hooks, routes }). Got ${describeShape(definition)}.`,
		);
	}
	const hooks = definition.hooks as Record<string, unknown> | undefined;
	const routes = definition.routes as Record<string, unknown> | undefined;

	if (hooks) {
		for (const hookName of Object.keys(hooks)) {
			const hookEntry = hooks[hookName];
			const handler = extractHookHandler(hookEntry);
			if (!handler) {
				throw new BundleError(
					"INVALID_PLUGIN_FORMAT",
					`${pluginEntry}: hook "${hookName}" must be a function or { handler: function, ... }. Got ${describeShape(hookEntry)}.`,
				);
			}
			const config: Record<string, unknown> =
				typeof hookEntry === "object" && hookEntry !== null
					? (hookEntry as Record<string, unknown>)
					: {};
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
				throw new BundleError(
					"INVALID_PLUGIN_FORMAT",
					`${pluginEntry}: route "${name}" must be a function or { handler: function, ... }. Got ${describeShape(route)}.`,
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
}

/**
 * Extract a hook handler from either the bare function form or the
 * `{ handler, priority, ... }` config form. Returns `undefined` if neither
 * shape is present so callers can hard-fail with a useful error.
 */
function extractHookHandler(entry: unknown): unknown {
	if (typeof entry === "function") return entry;
	if (entry && typeof entry === "object" && "handler" in entry) {
		const handler = (entry as { handler: unknown }).handler;
		if (typeof handler === "function") return handler;
	}
	return undefined;
}

/**
 * Same as `extractHookHandler` for route entries.
 */
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

interface CollectAssetsContext {
	pluginDir: string;
	bundleDir: string;
	log: BundleLogger;
	warn: (msg: string) => void;
}

async function collectAssets(ctx: CollectAssetsContext): Promise<void> {
	const { pluginDir, bundleDir, log, warn } = ctx;

	const readmePath = join(pluginDir, "README.md");
	if (await fileExists(readmePath)) {
		await copyFile(readmePath, join(bundleDir, "README.md"));
		log.success?.("Included README.md");
	}

	const iconPath = join(pluginDir, "icon.png");
	if (await fileExists(iconPath)) {
		const iconBuf = await readFile(iconPath);
		const dims = readImageDimensions(iconBuf);
		if (!dims) {
			warn("icon.png is not a valid PNG — skipping");
		} else {
			if (dims[0] !== ICON_SIZE || dims[1] !== ICON_SIZE) {
				warn(
					`icon.png is ${dims[0]}x${dims[1]}, expected ${ICON_SIZE}x${ICON_SIZE} — including anyway`,
				);
			}
			await copyFile(iconPath, join(bundleDir, "icon.png"));
			log.success?.("Included icon.png");
		}
	}

	const screenshotsDir = join(pluginDir, "screenshots");
	if (await fileExists(screenshotsDir)) {
		const screenshotFiles = (await readdir(screenshotsDir))
			.filter((f) => {
				const ext = extname(f).toLowerCase();
				return ext === ".png" || ext === ".jpg" || ext === ".jpeg";
			})
			.toSorted()
			.slice(0, MAX_SCREENSHOTS);

		if (screenshotFiles.length > 0) {
			await mkdir(join(bundleDir, "screenshots"), { recursive: true });
			for (const file of screenshotFiles) {
				const filePath = join(screenshotsDir, file);
				const buf = await readFile(filePath);
				const dims = readImageDimensions(buf);
				if (!dims) {
					warn(`screenshots/${file} — cannot read dimensions, skipping`);
					continue;
				}
				if (dims[0] > MAX_SCREENSHOT_WIDTH || dims[1] > MAX_SCREENSHOT_HEIGHT) {
					warn(
						`screenshots/${file} is ${dims[0]}x${dims[1]}, max ${MAX_SCREENSHOT_WIDTH}x${MAX_SCREENSHOT_HEIGHT} — including anyway`,
					);
				}
				await copyFile(filePath, join(bundleDir, "screenshots", file));
			}
			log.success?.(`Included ${screenshotFiles.length} screenshot(s)`);
		}
	}
}
