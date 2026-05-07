/**
 * Bundle utility functions.
 *
 * COPIED from `packages/core/src/cli/commands/bundle-utils.ts`. Kept in sync
 * with the legacy core copy until phase 1 cutover, when the legacy copy
 * goes away. Logic is unchanged; only the type imports point at the local
 * `./types.js` instead of core's plugin types.
 */

import { createWriteStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { imageSize } from "image-size";
import { packTar } from "modern-tar/fs";

import type { ManifestHookEntry, PluginManifest, ResolvedPlugin } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_BUNDLE_SIZE = 5 * 1024 * 1024;
export const MAX_SCREENSHOTS = 5;
export const MAX_SCREENSHOT_WIDTH = 1920;
export const MAX_SCREENSHOT_HEIGHT = 1080;
export const ICON_SIZE = 256;

// ── Regex patterns (module-scope to avoid re-compilation) ────────────────────

/**
 * Matches Node.js built-in imports in bundled output.
 * Captures the base module name (e.g. "fs" from "node:fs/promises").
 */
const NODE_BUILTIN_IMPORT_RE =
	/(?:import|export|require)\s*(?:\(|[^(]*?\bfrom\s+)["'](?:node:)?([a-z_]+)(?:\/[^"']*)?\s*["']\)?/g;
const LEADING_DOT_SLASH_RE = /^\.\//;
const DIST_PREFIX_RE = /^dist\//;
const MJS_EXT_RE = /\.m?js$/;
const TS_TO_TSX_RE = /\.ts$/;

/** Node.js built-in modules that shouldn't appear in sandbox code. */
const NODE_BUILTINS = new Set([
	"assert",
	"buffer",
	"child_process",
	"cluster",
	"crypto",
	"dgram",
	"dns",
	"domain",
	"events",
	"fs",
	"http",
	"http2",
	"https",
	"inspector",
	"module",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"punycode",
	"querystring",
	"readline",
	"repl",
	"stream",
	"string_decoder",
	"sys",
	"timers",
	"tls",
	"trace_events",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"wasi",
	"worker_threads",
	"zlib",
]);

// ── File helpers ─────────────────────────────────────────────────────────────

export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

// ── Image dimension readers ──────────────────────────────────────────────────

/**
 * Read image dimensions from a buffer.
 * Returns `[width, height]` or null if the format is unrecognized.
 */
export function readImageDimensions(buf: Uint8Array): [number, number] | null {
	try {
		const result = imageSize(buf);
		if (result.width != null && result.height != null) {
			return [result.width, result.height];
		}
		return null;
	} catch {
		return null;
	}
}

// ── Manifest extraction ──────────────────────────────────────────────────────

/**
 * Extract serialisable manifest metadata from a ResolvedPlugin.
 * Strips functions (hooks, route handlers) and keeps only the
 * publish-relevant fields.
 */
export function extractManifest(plugin: ResolvedPlugin): PluginManifest {
	const hooks: Array<ManifestHookEntry | string> = [];
	for (const [name, resolved] of Object.entries(plugin.hooks)) {
		if (!resolved) continue;
		const hasMetadata =
			resolved.exclusive ||
			(resolved.priority !== undefined && resolved.priority !== 100) ||
			(resolved.timeout !== undefined && resolved.timeout !== 5000);
		if (hasMetadata) {
			const entry: ManifestHookEntry = { name };
			if (resolved.exclusive) entry.exclusive = true;
			if (resolved.priority !== undefined && resolved.priority !== 100) {
				entry.priority = resolved.priority;
			}
			if (resolved.timeout !== undefined && resolved.timeout !== 5000) {
				entry.timeout = resolved.timeout;
			}
			hooks.push(entry);
		} else {
			hooks.push(name);
		}
	}

	return {
		id: plugin.id,
		version: plugin.version,
		capabilities: plugin.capabilities,
		allowedHosts: plugin.allowedHosts,
		storage: plugin.storage,
		hooks,
		routes: Object.keys(plugin.routes),
		admin: {
			// Omit `entry` (it's a module specifier for the host, not relevant in bundles)
			settingsSchema: plugin.admin.settingsSchema,
			pages: plugin.admin.pages,
			widgets: plugin.admin.widgets,
		},
	};
}

// ── Node.js built-in detection ───────────────────────────────────────────────

/**
 * Scan bundled code for Node.js built-in imports.
 * Matches patterns that appear in bundled ESM/CJS output (not source-level
 * named imports). Returns deduplicated array of built-in module names found.
 */
export function findNodeBuiltinImports(code: string): string[] {
	const found: string[] = [];
	NODE_BUILTIN_IMPORT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = NODE_BUILTIN_IMPORT_RE.exec(code)) !== null) {
		const mod = match[1];
		if (mod && NODE_BUILTINS.has(mod)) {
			found.push(mod);
		}
	}
	return [...new Set(found)];
}

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Find a build output file by base name, checking common extensions.
 * tsdown may output .mjs, .js, or .cjs depending on format and config.
 */
export async function findBuildOutput(dir: string, baseName: string): Promise<string | undefined> {
	for (const ext of [".mjs", ".js", ".cjs"]) {
		const candidate = join(dir, `${baseName}${ext}`);
		if (await fileExists(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Resolve a dist/built path back to its source `.ts`/`.tsx` equivalent.
 * E.g. `./dist/index.mjs` → `src/index.ts`.
 */
export async function resolveSourceEntry(
	pluginDir: string,
	distPath: string,
): Promise<string | undefined> {
	const cleaned = distPath.replace(LEADING_DOT_SLASH_RE, "");

	const srcPath = cleaned.replace(DIST_PREFIX_RE, "src/").replace(MJS_EXT_RE, ".ts");
	const srcFull = resolve(pluginDir, srcPath);
	if (await fileExists(srcFull)) return srcFull;

	const tsxPath = srcPath.replace(TS_TO_TSX_RE, ".tsx");
	const tsxFull = resolve(pluginDir, tsxPath);
	if (await fileExists(tsxFull)) return tsxFull;

	const direct = resolve(pluginDir, cleaned);
	if (await fileExists(direct)) return direct;

	return undefined;
}

// ── Export validation ────────────────────────────────────────────────────────

const TS_SOURCE_EXPORT_RE = /\.(?:ts|tsx|mts|cts|jsx)$/;

/**
 * Find `package.json` exports that point to source files instead of built
 * output. Source exports break sandbox publishing because the sandbox module
 * generator embeds the resolved file as-is.
 */
export function findSourceExports(
	exports: Record<string, unknown>,
): Array<{ exportPath: string; resolvedPath: string }> {
	const issues: Array<{ exportPath: string; resolvedPath: string }> = [];
	for (const [exportPath, exportValue] of Object.entries(exports)) {
		const resolvedPath =
			typeof exportValue === "string"
				? exportValue
				: exportValue && typeof exportValue === "object" && "import" in exportValue
					? typeof (exportValue as { import: unknown }).import === "string"
						? (exportValue as { import: string }).import
						: null
					: null;
		if (resolvedPath && TS_SOURCE_EXPORT_RE.test(resolvedPath)) {
			issues.push({ exportPath, resolvedPath });
		}
	}
	return issues;
}

// ── Directory helpers ────────────────────────────────────────────────────────

/**
 * Recursively calculate the total size of all files in a directory.
 */
export async function calculateDirectorySize(dir: string): Promise<number> {
	let total = 0;
	const items = await readdir(dir, { withFileTypes: true });
	for (const item of items) {
		const fullPath = join(dir, item.name);
		if (item.isFile()) {
			const s = await stat(fullPath);
			total += s.size;
		} else if (item.isDirectory()) {
			total += await calculateDirectorySize(fullPath);
		}
	}
	return total;
}

// ── Tarball creation ─────────────────────────────────────────────────────────

/**
 * Create a gzipped tarball from a directory.
 */
export async function createTarball(sourceDir: string, outputPath: string): Promise<void> {
	const { createGzip } = await import("node:zlib");
	const tarStream = packTar(sourceDir);
	const gzip = createGzip({ level: 9 });
	const out = createWriteStream(outputPath);
	await pipeline(tarStream, gzip, out);
}
