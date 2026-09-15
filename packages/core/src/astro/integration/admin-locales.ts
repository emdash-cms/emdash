/**
 * Admin locale allowlist helpers.
 *
 * Build-time utilities for validating a user-supplied list of admin UI
 * locales and rewiring locale catalog imports so only the listed locales
 * are bundled. Unlisted locales fall back to the source (English) catalog.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { Plugin } from "vite";

const DEFAULT_LOCALE = "en";
const SOURCE_MESSAGES_RE = /^\.\/([a-zA-Z0-9-]+)\/messages\.mjs$/;
const DIST_CHUNK_RE = /^\.\/messages-([A-Za-z0-9_-]+)\.js$/;
const LOCALE_LOADERS_ENTRY_RE =
	/"\.\/([a-zA-Z0-9-]+)\/messages\.mjs":\s*\(\)\s*=>\s*import\("\.\/messages-([A-Za-z0-9_-]+)\.js"\)/g;

/**
 * Resolve path to the admin package dist directory.
 * Used for Vite alias to ensure the package is found in pnpm's isolated node_modules.
 */
export function resolveAdminDist(): string {
	const require = createRequire(import.meta.url);
	const adminPath = require.resolve("@emdash-cms/admin");
	return dirname(adminPath);
}

/**
 * Resolve path to the admin package source directory.
 * In dev mode inside this repo, we alias @emdash-cms/admin to the source so
 * Vite processes it directly — giving instant HMR instead of requiring a
 * rebuild + restart. External apps should use the built package surface.
 */
export function resolveAdminSource(projectRoot: string): string | undefined {
	const require = createRequire(import.meta.url);
	const adminPath = require.resolve("@emdash-cms/admin");
	const packageRoot = resolve(dirname(adminPath), "..");
	const repoRoot = resolve(packageRoot, "..", "..");
	const srcEntry = resolve(packageRoot, "src", "index.ts");

	try {
		if (existsSync(srcEntry) && isInside(repoRoot, projectRoot)) {
			return resolve(packageRoot, "src");
		}
	} catch {
		// Not in local repo — fall back to dist
	}
	return undefined;
}

/**
 * Check whether child is inside parent without relying on simple prefix checks.
 */
function isInside(parent: string, child: string): boolean {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Read the locale codes that actually have compiled catalogs in the admin
 * package. The returned set drives config-time validation and runtime
 * filtering; keeping it filesystem-based means the allowlist automatically
 * matches whatever locales the installed admin version ships.
 */
export function getAdminLocaleCodes(adminDistPath: string): Set<string> {
	const codes = new Set<string>();
	const localesDir = resolve(adminDistPath, "locales");

	try {
		for (const entry of readdirSync(localesDir)) {
			const entryPath = resolve(localesDir, entry);
			if (statSync(entryPath).isDirectory() && existsSync(resolve(entryPath, "messages.mjs"))) {
				codes.add(entry);
			}
		}
	} catch {
		// If the admin package has no compiled locales (shouldn't happen in a
		// real install), fall through to an empty set and let validation fail
		// clearly if the user supplied an allowlist.
	}

	return codes;
}

/**
 * Validate and canonicalize a user-supplied admin locale allowlist.
 *
 * - Each entry must be a non-empty BCP 47 tag that names a locale the admin
 *   actually ships.
 * - The source locale (English) must be present so the fallback catalog is
 *   always available.
 * - Entries are de-duplicated and canonicalized via Intl.Locale.
 */
export function validateAdminLocales(
	input: unknown,
	knownCodes: Iterable<string>,
	sourceLocale = DEFAULT_LOCALE,
): string[] | undefined {
	if (input === undefined) return undefined;

	if (!Array.isArray(input)) {
		throw new Error("`admin.locales` must be an array of locale codes.");
	}
	if (input.length === 0) {
		throw new Error("`admin.locales` cannot be empty.");
	}

	const known = new Set(knownCodes);
	const result: string[] = [];
	const seen = new Set<string>();

	for (const raw of input) {
		if (typeof raw !== "string" || raw.trim() === "") {
			throw new Error("`admin.locales` entries must be non-empty locale codes.");
		}

		let canonical: string;
		try {
			canonical = new Intl.Locale(raw.trim()).baseName;
		} catch {
			throw new Error(`Invalid locale code in \`admin.locales\`: "${raw}".`);
		}

		if (!known.has(canonical)) {
			throw new Error(
				`Unknown admin locale: "${canonical}". ` +
					`Supported locales are: ${[...known].join(", ")}.`,
			);
		}

		if (!seen.has(canonical)) {
			seen.add(canonical);
			result.push(canonical);
		}
	}

	if (!seen.has(sourceLocale)) {
		throw new Error(
			`\`admin.locales\` must include the source locale "${sourceLocale}" ` +
				`so the admin has a fallback catalog.`,
		);
	}

	return result;
}

interface LocaleChunkInfo {
	/** Map from chunk filename hash (e.g. "gTCuzb6s") to locale code. */
	hashToLocale: Map<string, string>;
	/** Filename of the source (English) chunk, e.g. "messages-gTCuzb6s.js". */
	defaultChunk: string | undefined;
}

/**
 * Parse the admin dist chunk containing `LOCALE_LOADERS` so we know which
 * hashed chunk belongs to which locale. This is the only reliable way to map
 * the pre-hashed filenames in the built admin back to locale codes.
 */
function buildLocaleChunkMap(adminDistPath: string, defaultLocale: string): LocaleChunkInfo {
	const hashToLocale = new Map<string, string>();
	let defaultChunk: string | undefined;

	try {
		for (const file of readdirSync(adminDistPath)) {
			if (!file.endsWith(".js") || file.endsWith(".map")) continue;

			const content = readFileSync(resolve(adminDistPath, file), "utf8");
			if (!content.includes("LOCALE_LOADERS")) continue;

			for (const match of content.matchAll(LOCALE_LOADERS_ENTRY_RE)) {
				const locale = match[1]!;
				const hash = match[2]!;
				hashToLocale.set(hash, locale);
				if (locale === defaultLocale) {
					defaultChunk = `messages-${hash}.js`;
				}
			}

			// Only one chunk contains the loader map.
			break;
		}
	} catch {
		// Leave the map empty; resolution will fall back to Rollup defaults.
	}

	return { hashToLocale, defaultChunk };
}

interface AdminLocaleResolverOptions {
	adminDistPath: string;
	adminSourcePath?: string;
	locales: string[];
	defaultLocale?: string;
}

/**
 * Vite plugin that redirects admin locale imports and hashed locale chunks
 * for locales outside the allowlist back to the source (default) locale.
 *
 * In dev mode with the admin package aliased to source, imports look like
 * `./de/messages.mjs`. In production builds that consume the pre-built admin
 * dist, imports look like `./messages-<hash>.js`. Both forms are handled.
 */
export function createAdminLocaleResolverPlugin(options: AdminLocaleResolverOptions): Plugin {
	const { adminDistPath, adminSourcePath, locales, defaultLocale = DEFAULT_LOCALE } = options;
	const allowed = new Set(locales);
	const { hashToLocale, defaultChunk } = buildLocaleChunkMap(adminDistPath, defaultLocale);

	const defaultMessagesPath = resolve(adminDistPath, "locales", defaultLocale, "messages.mjs");

	return {
		name: "emdash-admin-locales",
		enforce: "pre",
		resolveId(source, importer) {
			if (!importer) return;

			const isSourceImporter =
				adminSourcePath !== undefined && importer.startsWith(adminSourcePath);
			const isDistImporter = importer.startsWith(adminDistPath);
			if (!isSourceImporter && !isDistImporter) return;

			// Dev-mode import from admin source: ./de/messages.mjs
			const sourceMatch = SOURCE_MESSAGES_RE.exec(source);
			if (sourceMatch) {
				const locale = sourceMatch[1]!;
				if (locale === defaultLocale || allowed.has(locale)) {
					// Let the Lingui macro plugin (dev source mode) or Rollup handle allowed locales.
					return;
				}
				return defaultMessagesPath;
			}

			// Production import from admin dist: ./messages-<hash>.js
			const chunkMatch = DIST_CHUNK_RE.exec(source);
			if (chunkMatch && defaultChunk) {
				const hash = chunkMatch[1]!;
				const locale = hashToLocale.get(hash);
				if (!locale) return;
				if (locale === defaultLocale || allowed.has(locale)) return;
				return resolve(adminDistPath, defaultChunk);
			}
		},
	};
}
