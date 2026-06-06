/**
 * Bundle utility functions
 *
 * Shared logic extracted from the bundle command so it can be tested
 * without the CLI harness and tsdown dependency.
 */

import { createWriteStream } from "node:fs";
import { readdir, stat, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { imageSize } from "image-size";
import { packTar } from "modern-tar/fs";

import type {
	PluginManifest,
	ResolvedPlugin,
	HookName,
	ManifestHookEntry,
} from "../../plugins/types.js";

// ── Constants ────────────────────────────────────────────────────────────────

// Bundle size caps per RFC 0001 §"Bundle size limits". These are decompressed
// sizes; the gzipped tarball is typically a fraction of MAX_BUNDLE_SIZE.
export const MAX_BUNDLE_SIZE = 256 * 1024;
export const MAX_FILE_SIZE = 128 * 1024;
export const MAX_FILE_COUNT = 20;

export const MAX_SCREENSHOTS = 5;
export const MAX_SCREENSHOT_WIDTH = 1920;
export const MAX_SCREENSHOT_HEIGHT = 1080;
export const ICON_SIZE = 256;

// ── Regex patterns (module-scope to avoid re-compilation) ────────────────────

/**
 * Matches Node.js built-in imports in bundled output:
 * - require("node:xxx") / require("xxx")
 * - import("node:xxx") / import("xxx")
 * - import X from "node:xxx" / import { X } from "node:xxx"
 * - import * as X from "node:xxx"
 * - export { X } from "node:xxx"
 * Captures the base module name (e.g. "fs" from "node:fs/promises").
 */
const NODE_BUILTIN_IMPORT_RE =
	/(?:import|export|require)\s*(?:\(|[^(]*?\bfrom\s+)["'](?:node:)?([a-z_]+)(?:\/[^"']*)?\s*["']\)?/g;
const LEADING_DOT_SLASH_RE = /^\.\//;
const DIST_PREFIX_RE = /^dist\//;
const MJS_EXT_RE = /\.m?js$/;
const TS_TO_TSX_RE = /\.ts$/;

/** Node.js built-in modules that shouldn't appear in sandbox code */
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
 * Returns [width, height] or null if the format is unrecognized.
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
 * Extract manifest metadata from a ResolvedPlugin.
 * Strips functions (hooks, route handlers) and keeps only serializable metadata.
 */
export function extractManifest(plugin: ResolvedPlugin): PluginManifest {
	// Build hook entries preserving exclusive/priority/timeout metadata.
	// Plain HookName strings are emitted for hooks with default settings;
	// structured ManifestHookEntry objects are emitted when metadata differs.
	const hooks: Array<ManifestHookEntry | HookName> = [];
	for (const [name, resolved] of Object.entries(plugin.hooks)) {
		if (!resolved) continue;
		const hasMetadata =
			resolved.exclusive || resolved.priority !== 100 || resolved.timeout !== 5000;
		if (hasMetadata) {
			const entry: ManifestHookEntry = { name };
			if (resolved.exclusive) entry.exclusive = true;
			if (resolved.priority !== 100) entry.priority = resolved.priority;
			if (resolved.timeout !== 5000) entry.timeout = resolved.timeout;
			hooks.push(entry);
		} else {
			hooks.push(name as HookName);
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
			// Omit entry (it's a module specifier for the host, not relevant in bundles)
			settingsSchema: plugin.admin.settingsSchema,
			pages: plugin.admin.pages,
			widgets: plugin.admin.widgets,
		},
	};
}

// ── Node.js built-in detection ───────────────────────────────────────────────

/**
 * Scan bundled code for Node.js built-in imports.
 * Matches require("node:xxx"), require("xxx"), import("node:xxx") — the patterns
 * that appear in bundled ESM/CJS output (not source-level named imports).
 * Returns deduplicated array of built-in module names found.
 */
export function findNodeBuiltinImports(code: string): string[] {
	const found: string[] = [];
	NODE_BUILTIN_IMPORT_RE.lastIndex = 0;
	let match;
	while ((match = NODE_BUILTIN_IMPORT_RE.exec(code)) !== null) {
		const mod = match[1];
		if (NODE_BUILTINS.has(mod)) {
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
 * Resolve a dist/built path back to its source .ts/.tsx equivalent.
 * E.g., "./dist/index.mjs" → "src/index.ts"
 */
export async function resolveSourceEntry(
	pluginDir: string,
	distPath: string,
): Promise<string | undefined> {
	const cleaned = distPath.replace(LEADING_DOT_SLASH_RE, "");

	// Prefer source over dist — dist/foo.mjs → src/foo.ts
	const srcPath = cleaned.replace(DIST_PREFIX_RE, "src/").replace(MJS_EXT_RE, ".ts");
	const srcFull = resolve(pluginDir, srcPath);
	if (await fileExists(srcFull)) return srcFull;

	// Try .tsx
	const tsxPath = srcPath.replace(TS_TO_TSX_RE, ".tsx");
	const tsxFull = resolve(pluginDir, tsxPath);
	if (await fileExists(tsxFull)) return tsxFull;

	// Fall back to direct path (might be source already, or pre-compiled plugin)
	const direct = resolve(pluginDir, cleaned);
	if (await fileExists(direct)) return direct;

	return undefined;
}

// ── Export validation ───────────────────────────────────────────────────────

const TS_SOURCE_EXPORT_RE = /\.(?:ts|tsx|mts|cts|jsx)$/;

/**
 * Find package.json exports that point to source files instead of built output.
 * Returns an array of `{ exportPath, resolvedPath }` for each offending export.
 */
export function findSourceExports(
	exports: Record<string, unknown>,
): Array<{ exportPath: string; resolvedPath: string }> {
	const issues: Array<{ exportPath: string; resolvedPath: string }> = [];
	for (const [exportPath, exportValue] of Object.entries(exports)) {
		const resolved =
			typeof exportValue === "string"
				? exportValue
				: exportValue && typeof exportValue === "object" && "import" in exportValue
					? (exportValue as { import: string }).import
					: null;
		if (resolved && TS_SOURCE_EXPORT_RE.test(resolved)) {
			issues.push({ exportPath, resolvedPath: resolved });
		}
	}
	return issues;
}

// ── Directory helpers ────────────────────────────────────────────────────────

/**
 * One file in a bundle: a tarball-relative path and its byte length.
 * Produced by `collectBundleEntries` (from a staging dir) or by the publish
 * flow (from tarball entries); consumed by `validateBundleSize`.
 */
export interface BundleFileEntry {
	name: string;
	bytes: number;
}

/**
 * Recursively walk a staging directory and return a flat list of all files
 * with sizes. Names are relative to `dir` so they match what would appear
 * as the tarball entry name.
 */
export async function collectBundleEntries(dir: string): Promise<BundleFileEntry[]> {
	const entries: BundleFileEntry[] = [];
	await walkBundle(dir, "", entries);
	return entries;
}

async function walkBundle(dir: string, prefix: string, into: BundleFileEntry[]): Promise<void> {
	const items = await readdir(dir, { withFileTypes: true });
	for (const item of items) {
		const fullPath = join(dir, item.name);
		const relPath = prefix ? `${prefix}/${item.name}` : item.name;
		if (item.isFile()) {
			const s = await stat(fullPath);
			into.push({ name: relPath, bytes: s.size });
		} else if (item.isDirectory()) {
			await walkBundle(fullPath, relPath, into);
		}
	}
}

/**
 * Sum the byte sizes of all entries.
 */
export function totalBundleBytes(entries: readonly BundleFileEntry[]): number {
	let total = 0;
	for (const e of entries) total += e.bytes;
	return total;
}

/**
 * Check a bundle against the three size caps from RFC 0001:
 *   - total decompressed ≤ MAX_BUNDLE_SIZE
 *   - per-file decompressed ≤ MAX_FILE_SIZE
 *   - file count ≤ MAX_FILE_COUNT
 *
 * Returns a list of violation messages (empty if the bundle is within all
 * caps). Messages are deterministic per input — the total/count violations
 * come first, then oversized files in alphabetical order — so the same
 * bundle always produces the same error text.
 */
export function validateBundleSize(entries: readonly BundleFileEntry[]): string[] {
	const violations: string[] = [];
	const total = totalBundleBytes(entries);
	if (total > MAX_BUNDLE_SIZE) {
		violations.push(
			`Bundle size ${formatBytes(total)} exceeds maximum of ${formatBytes(MAX_BUNDLE_SIZE)}.`,
		);
	}
	if (entries.length > MAX_FILE_COUNT) {
		violations.push(
			`Bundle contains ${entries.length} files, exceeds maximum of ${MAX_FILE_COUNT}.`,
		);
	}
	const oversized = entries
		.filter((e) => e.bytes > MAX_FILE_SIZE)
		.toSorted((a, b) => a.name.localeCompare(b.name));
	for (const e of oversized) {
		violations.push(
			`File ${e.name} is ${formatBytes(e.bytes)}, exceeds per-file maximum of ${formatBytes(MAX_FILE_SIZE)}.`,
		);
	}
	return violations;
}

/**
 * Render a byte count as a human-friendly string (e.g. "256.0 KB").
 */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
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
