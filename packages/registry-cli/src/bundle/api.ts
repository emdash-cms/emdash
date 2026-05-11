/**
 * Programmatic plugin-bundling API.
 *
 * Pure-ish core of the bundling pipeline -- no `process.exit`, no console
 * output. The CLI in `./command.ts` is a thin wrapper that turns these calls
 * into pretty terminal output; tests exercise this module directly.
 *
 * The bundling steps:
 *
 *   1. Resolve plugin entrypoints from the user's `package.json`.
 *   2. Build the main entry with `tsdown` and dynamically import it to
 *      extract a `ResolvedPlugin` (descriptor factory or `createPlugin`).
 *   3. If a sandbox entry exists, build it twice — once as a probe to
 *      capture hook/route names for the manifest, once as the final
 *      `backend.js` (minified, with `emdash` aliased to a no-op shim).
 *   4. Build `admin.js` if an admin entry is declared.
 *   5. Write `manifest.json` and copy assets (README, icon, screenshots).
 *   6. Validate (size limits, no Node builtins, no source exports, admin
 *      route consistency, sandbox-incompatible features).
 *   7. Create the gzipped tarball and return its checksum.
 *
 * Failures throw `BundleError` with a structured `code` so callers can
 * branch (CLI shows a helpful message; tests assert the code).
 */

import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

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
	findSourceExports,
	formatBytes,
	ICON_SIZE,
	MAX_SCREENSHOTS,
	MAX_SCREENSHOT_HEIGHT,
	MAX_SCREENSHOT_WIDTH,
	readImageDimensions,
	resolveSourceEntry,
	totalBundleBytes,
	validateBundleSize,
} from "./utils.js";

const TS_EXT_RE = /\.(tsx?|[mc]?js)$/;
const SLASH_RE = /\//g;
const LEADING_AT_RE = /^@/;
const EMDASH_SCOPE_RE = /^@emdash-cms\//;

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type BundleErrorCode =
	| "MISSING_PACKAGE_JSON"
	| "MISSING_ENTRYPOINT"
	| "MAIN_BUILD_FAILED"
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

interface ResolvedEntries {
	mainEntry: string;
	backendEntry: string | undefined;
	adminEntry: string | undefined;
	pkg: PackageJson;
}

interface PackageJson {
	name?: string;
	main?: string;
	exports?: Record<string, unknown>;
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

	// ── 1. Read package.json and resolve entrypoints ──
	const entries = await resolveEntries(pluginDir, log);

	// ── 2. Extract manifest by importing the plugin ──
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

		const resolvedPlugin = await extractResolvedPlugin({
			pluginDir,
			tmpDir,
			entries,
			build,
		});

		const manifest = extractManifest(resolvedPlugin);

		// Sandboxed plugins must not declare native-mode-only features.
		if (resolvedPlugin.admin?.entry) {
			throw new BundleError(
				"TRUSTED_ONLY_FEATURE",
				"Plugin declares adminEntry — React admin components require native/trusted mode. Use Block Kit for sandboxed admin pages, or remove adminEntry.",
			);
		}
		if (
			resolvedPlugin.admin?.portableTextBlocks &&
			resolvedPlugin.admin.portableTextBlocks.length > 0
		) {
			throw new BundleError(
				"TRUSTED_ONLY_FEATURE",
				"Plugin declares portableTextBlocks — these require native/trusted mode and cannot be bundled for the marketplace.",
			);
		}

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

		if (entries.backendEntry) {
			log.start?.("Bundling backend...");
			const shimPath = await writeEmdashShim(join(tmpDir, "shims"));

			await build({
				config: false,
				entry: [entries.backendEntry],
				format: "esm",
				outDir: join(tmpDir, "backend"),
				dts: false,
				platform: "neutral",
				external: [],
				alias: { emdash: shimPath },
				minify: true,
				treeshake: true,
			});

			const backendBaseName = basename(entries.backendEntry).replace(TS_EXT_RE, "");
			const backendOutputPath = await findBuildOutput(join(tmpDir, "backend"), backendBaseName);
			if (!backendOutputPath) {
				throw new BundleError("BACKEND_BUILD_FAILED", "Backend build produced no output");
			}
			await copyFile(backendOutputPath, join(bundleDir, "backend.js"));
			log.success?.("Built backend.js");
		} else {
			warn(
				'No sandbox entry found — bundle will have no backend.js. Add "src/sandbox-entry.ts" or a "./sandbox" export.',
			);
		}

		// ── 4. Bundle admin.js ──
		if (entries.adminEntry) {
			log.start?.("Bundling admin...");
			await build({
				config: false,
				entry: [entries.adminEntry],
				format: "esm",
				outDir: join(tmpDir, "admin"),
				dts: false,
				platform: "neutral",
				external: [],
				minify: true,
				treeshake: true,
			});

			const adminBaseName = basename(entries.adminEntry).replace(TS_EXT_RE, "");
			const adminOutputPath = await findBuildOutput(join(tmpDir, "admin"), adminBaseName);
			if (adminOutputPath) {
				await copyFile(adminOutputPath, join(bundleDir, "admin.js"));
				log.success?.("Built admin.js");
			}
		}

		// ── 5. Write manifest.json ──
		await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));

		// ── 6. Collect assets ──
		log.start?.("Collecting assets...");
		await collectAssets({ pluginDir, bundleDir, log, warn });

		// ── 7. Validate ──
		log.start?.("Validating bundle...");
		const validationErrors: string[] = [];

		// Source exports check (npm-published plugins must point at built files).
		if (entries.pkg.exports) {
			for (const issue of findSourceExports(entries.pkg.exports)) {
				validationErrors.push(
					`Export "${issue.exportPath}" points to source (${issue.resolvedPath}). Package exports must point to built files (e.g. dist/*.mjs).`,
				);
			}
		}

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

async function resolveEntries(pluginDir: string, log: BundleLogger): Promise<ResolvedEntries> {
	const pkgPath = join(pluginDir, "package.json");
	if (!(await fileExists(pkgPath))) {
		throw new BundleError("MISSING_PACKAGE_JSON", `No package.json found in ${pluginDir}`);
	}

	const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as PackageJson;

	let backendEntry: string | undefined;
	let adminEntry: string | undefined;

	if (pkg.exports) {
		const sandboxExport = pkg.exports["./sandbox"];
		if (typeof sandboxExport === "string") {
			backendEntry = await resolveSourceEntry(pluginDir, sandboxExport);
		} else if (
			sandboxExport &&
			typeof sandboxExport === "object" &&
			"import" in sandboxExport &&
			typeof (sandboxExport as { import: unknown }).import === "string"
		) {
			backendEntry = await resolveSourceEntry(
				pluginDir,
				(sandboxExport as { import: string }).import,
			);
		}

		const adminExport = pkg.exports["./admin"];
		if (typeof adminExport === "string") {
			adminEntry = await resolveSourceEntry(pluginDir, adminExport);
		} else if (
			adminExport &&
			typeof adminExport === "object" &&
			"import" in adminExport &&
			typeof (adminExport as { import: unknown }).import === "string"
		) {
			adminEntry = await resolveSourceEntry(pluginDir, (adminExport as { import: string }).import);
		}
	}

	if (!backendEntry) {
		const defaultSandbox = join(pluginDir, "src/sandbox-entry.ts");
		if (await fileExists(defaultSandbox)) {
			backendEntry = defaultSandbox;
		}
	}

	let mainEntry: string | undefined;
	if (pkg.exports?.["."] !== undefined) {
		const mainExport = pkg.exports["."];
		if (typeof mainExport === "string") {
			mainEntry = await resolveSourceEntry(pluginDir, mainExport);
		} else if (
			mainExport &&
			typeof mainExport === "object" &&
			"import" in mainExport &&
			typeof (mainExport as { import: unknown }).import === "string"
		) {
			mainEntry = await resolveSourceEntry(pluginDir, (mainExport as { import: string }).import);
		}
	}
	if (!mainEntry && pkg.main) {
		mainEntry = await resolveSourceEntry(pluginDir, pkg.main);
	}
	if (!mainEntry) {
		const defaultMain = join(pluginDir, "src/index.ts");
		if (await fileExists(defaultMain)) {
			mainEntry = defaultMain;
		}
	}

	if (!mainEntry) {
		throw new BundleError(
			"MISSING_ENTRYPOINT",
			"Cannot find plugin entrypoint. Expected src/index.ts or main/exports in package.json.",
		);
	}

	log.info?.(`Main entry: ${mainEntry}`);
	if (backendEntry) log.info?.(`Backend entry: ${backendEntry}`);
	if (adminEntry) log.info?.(`Admin entry: ${adminEntry}`);

	return { mainEntry, backendEntry, adminEntry, pkg };
}

interface ExtractContext {
	pluginDir: string;
	tmpDir: string;
	entries: ResolvedEntries;
	build: typeof import("tsdown").build;
}

async function extractResolvedPlugin(ctx: ExtractContext): Promise<ResolvedPlugin> {
	const { pluginDir, tmpDir, entries, build } = ctx;
	const mainOutDir = join(tmpDir, "main");
	await build({
		config: false,
		entry: [entries.mainEntry],
		format: "esm",
		outDir: mainOutDir,
		dts: false,
		platform: "node",
		external: ["emdash", EMDASH_SCOPE_RE],
	});

	const pluginNodeModules = join(pluginDir, "node_modules");
	const tmpNodeModules = join(mainOutDir, "node_modules");
	if (await fileExists(pluginNodeModules)) {
		await symlink(pluginNodeModules, tmpNodeModules, "junction");
	}

	const mainBaseName = basename(entries.mainEntry).replace(TS_EXT_RE, "");
	const mainOutputPath = await findBuildOutput(mainOutDir, mainBaseName);
	if (!mainOutputPath) {
		throw new BundleError(
			"MAIN_BUILD_FAILED",
			`Failed to build main entry — no output found in ${mainOutDir}`,
		);
	}

	const pluginModule = (await import(mainOutputPath)) as Record<string, unknown>;

	let resolvedPlugin: ResolvedPlugin | undefined;
	let descriptor: Record<string, unknown> | undefined;

	// Strict format detection. We only call exports we can identify by name --
	// `createPlugin()` (native) or the default export (standard descriptor or
	// pre-resolved object). Speculatively calling every named export is a
	// foot-gun: a `validateInput()` helper that returns `{id, version}` would
	// be mis-resolved.
	if (typeof pluginModule.createPlugin === "function") {
		const native = (pluginModule.createPlugin as () => unknown)();
		if (!isResolvedPluginShape(native)) {
			throw new BundleError(
				"INVALID_PLUGIN_FORMAT",
				"createPlugin() returned something that's not a ResolvedPlugin (missing id, version, or wrong types).",
			);
		}
		resolvedPlugin = native;
	} else if (typeof pluginModule.default === "function") {
		// Standard format default export. The factory returns a descriptor
		// (id + version + serialisable fields, no hook handlers); we build
		// the ResolvedPlugin shape around it and probe the sandbox entry for
		// hook/route names below.
		const result = (pluginModule.default as () => unknown)();
		if (!isPluginDescriptorShape(result)) {
			throw new BundleError(
				"INVALID_PLUGIN_FORMAT",
				"Default export factory returned something that's not a plugin descriptor (missing id or version, or wrong types).",
			);
		}
		descriptor = result;
		resolvedPlugin = buildResolvedFromDescriptor(result);
	} else if (typeof pluginModule.default === "object" && pluginModule.default !== null) {
		const defaultExport = pluginModule.default;
		if (!isResolvedPluginShape(defaultExport)) {
			throw new BundleError(
				"INVALID_PLUGIN_FORMAT",
				"Default export object is not a ResolvedPlugin (missing id, version, or wrong types).",
			);
		}
		resolvedPlugin = defaultExport;
	}

	if (!resolvedPlugin) {
		throw new BundleError(
			"INVALID_PLUGIN_FORMAT",
			"Could not extract plugin definition. Expected one of:\n" +
				"  - `export function createPlugin() { ... }` (native format)\n" +
				"  - `export default function() { return { id, version, ... } }` (standard format)\n" +
				"  - `export default { id, version, ... }` (pre-resolved native)",
		);
	}

	// For the standard format, probe the sandbox entry to capture hook and
	// route names for the manifest. Only runs when we have a descriptor (i.e.
	// the plugin came in via the standard format) and a sandbox entry.
	if (descriptor && entries.backendEntry) {
		await augmentWithSandboxProbe({
			resolvedPlugin,
			descriptor,
			backendEntry: entries.backendEntry,
			tmpDir,
			build,
		});
	}

	// If a standard-format descriptor declares hooks/routes we couldn't probe
	// (because there's no sandbox entry), the published manifest will be a
	// lie -- the host will refuse to dispatch hooks the plugin promised to
	// implement. Catch it here.
	if (
		descriptor &&
		!entries.backendEntry &&
		(hasNonEmptyArrayField(descriptor, "hooks") || hasNonEmptyArrayField(descriptor, "routes"))
	) {
		throw new BundleError(
			"INVALID_PLUGIN_FORMAT",
			"Plugin descriptor declares hooks or routes but no sandbox entry exists to back them. " +
				'Add `src/sandbox-entry.ts` (or a "./sandbox" export in package.json) that ' +
				"exports `default { hooks, routes }`. Without it, the published manifest " +
				"will promise functionality the bundle can't deliver.",
		);
	}

	return resolvedPlugin;
}

function buildResolvedFromDescriptor(descriptor: Record<string, unknown>): ResolvedPlugin {
	return {
		id: descriptor.id as string,
		version: descriptor.version as string,
		capabilities: (descriptor.capabilities as ResolvedPlugin["capabilities"]) ?? [],
		allowedHosts: (descriptor.allowedHosts as string[]) ?? [],
		storage: (descriptor.storage as ResolvedPlugin["storage"]) ?? {},
		hooks: {},
		routes: {},
		admin: {
			pages: descriptor.adminPages as ResolvedPlugin["admin"]["pages"],
			widgets: descriptor.adminWidgets as ResolvedPlugin["admin"]["widgets"],
		},
	};
}

/**
 * Type guard: does this value look like a `ResolvedPlugin` enough to use?
 *
 * Validates the fields we read in the bundling pipeline. Doesn't try to
 * exhaustively validate hook/route handler shapes -- those are functions and
 * the manifest only records their names.
 */
function isResolvedPluginShape(value: unknown): value is ResolvedPlugin {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0) return false;
	if (typeof v.version !== "string" || v.version.length === 0) return false;
	if (v.capabilities !== undefined && !Array.isArray(v.capabilities)) return false;
	if (v.allowedHosts !== undefined && !Array.isArray(v.allowedHosts)) return false;
	if (v.storage !== undefined && (typeof v.storage !== "object" || v.storage === null)) {
		return false;
	}
	if (v.hooks !== undefined && (typeof v.hooks !== "object" || v.hooks === null)) {
		return false;
	}
	if (v.routes !== undefined && (typeof v.routes !== "object" || v.routes === null)) {
		return false;
	}
	if (v.admin !== undefined && (typeof v.admin !== "object" || v.admin === null)) {
		return false;
	}
	return true;
}

/**
 * Type guard: does this value look like a plugin descriptor (the standard
 * format's factory return value)?
 *
 * Looser than `isResolvedPluginShape` -- descriptors don't carry hooks or
 * routes (those live in the sandbox entry, probed separately).
 */
function isPluginDescriptorShape(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0) return false;
	if (typeof v.version !== "string" || v.version.length === 0) return false;
	if (v.capabilities !== undefined) {
		if (!Array.isArray(v.capabilities)) return false;
		// Reject non-string entries -- they'd serialize into a malformed
		// manifest.json and confuse the runtime.
		if (v.capabilities.some((c) => typeof c !== "string")) return false;
	}
	if (v.allowedHosts !== undefined) {
		if (!Array.isArray(v.allowedHosts)) return false;
		if (v.allowedHosts.some((h) => typeof h !== "string")) return false;
	}
	return true;
}

/**
 * `descriptor[field]` is a non-empty array (or non-empty object). Used to
 * detect when a standard-format descriptor declares hooks/routes that the
 * bundler can't populate (because there's no sandbox entry to probe).
 */
function hasNonEmptyArrayField(descriptor: Record<string, unknown>, field: string): boolean {
	const v = descriptor[field];
	if (Array.isArray(v)) return v.length > 0;
	if (v && typeof v === "object") return Object.keys(v).length > 0;
	return false;
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
	descriptor: Record<string, unknown>;
	backendEntry: string;
	tmpDir: string;
	build: typeof import("tsdown").build;
}

async function augmentWithSandboxProbe(ctx: ProbeContext): Promise<void> {
	const { resolvedPlugin, descriptor, backendEntry, tmpDir, build } = ctx;
	const backendProbeDir = join(tmpDir, "backend-probe");
	const probeShimPath = await writeEmdashShim(join(tmpDir, "probe-shims"));
	await build({
		config: false,
		entry: [backendEntry],
		format: "esm",
		outDir: backendProbeDir,
		dts: false,
		platform: "neutral",
		external: [],
		alias: { emdash: probeShimPath },
		treeshake: true,
	});
	const backendBaseName = basename(backendEntry).replace(TS_EXT_RE, "");
	const backendProbePath = await findBuildOutput(backendProbeDir, backendBaseName);
	if (!backendProbePath) return;

	const backendModule = (await import(backendProbePath)) as Record<string, unknown>;
	const standardDef = (backendModule.default ?? {}) as Record<string, unknown>;
	const hooks = standardDef.hooks as Record<string, unknown> | undefined;
	const routes = standardDef.routes as Record<string, unknown> | undefined;

	if (hooks) {
		for (const hookName of Object.keys(hooks)) {
			const hookEntry = hooks[hookName];
			const handler = extractHookHandler(hookEntry);
			if (!handler) {
				throw new BundleError(
					"INVALID_PLUGIN_FORMAT",
					`Sandbox entry's hook "${hookName}" must be a function or { handler: function, ... }. Got ${describeShape(hookEntry)}.`,
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
				pluginId: descriptor.id as string,
			};
		}
	}
	if (routes) {
		for (const [name, route] of Object.entries(routes)) {
			const handler = extractRouteHandler(route);
			if (!handler) {
				throw new BundleError(
					"INVALID_PLUGIN_FORMAT",
					`Sandbox entry's route "${name}" must be a function or { handler: function, ... }. Got ${describeShape(route)}.`,
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
