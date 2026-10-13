/**
 * Build-time support for the `admin.locales` allowlist: validates it against
 * the catalogs the installed admin package ships, and keeps excluded catalogs
 * out of the bundle by resolving their imports to the source-locale catalog.
 */

import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

import type { Plugin } from "vite";

const SOURCE_LOCALE = "en";
const MANIFEST_FILE = "locales-manifest.json";
const QUERY_RE = /[?#].*$/;

/** Locale code mapped to its catalog chunk, relative to the admin dist directory. */
export type AdminLocaleManifest = Record<string, string>;

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

/**
 * Read the locale manifest emitted by the `@emdash-cms/admin` build. Throws if
 * it is missing, malformed, lacks the source locale, or names a chunk that is
 * not in the dist directory.
 */
export function readAdminLocaleManifest(adminDistPath: string): AdminLocaleManifest {
	const manifestPath = resolve(adminDistPath, MANIFEST_FILE);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(
			`\`admin.locales\` needs the admin locale manifest at ${manifestPath}, but it could not be read. ` +
				"Reinstall or rebuild @emdash-cms/admin.",
			{ cause: error },
		);
	}

	const locales =
		typeof parsed === "object" && parsed !== null && "locales" in parsed
			? parsed.locales
			: undefined;
	if (!isStringRecord(locales) || !Object.hasOwn(locales, SOURCE_LOCALE)) {
		throw new Error(
			`The admin locale manifest at ${manifestPath} is invalid: expected a "locales" object ` +
				`mapping locale codes to chunk files, including "${SOURCE_LOCALE}". ` +
				"Reinstall or rebuild @emdash-cms/admin.",
		);
	}

	for (const [code, chunk] of Object.entries(locales)) {
		if (!existsSync(resolve(adminDistPath, chunk))) {
			throw new Error(
				`The admin locale manifest at ${manifestPath} lists "${chunk}" for "${code}", ` +
					"but that file does not exist. Reinstall or rebuild @emdash-cms/admin.",
			);
		}
	}

	return locales;
}

function canonicalizeLocale(code: string): string | undefined {
	try {
		return new Intl.Locale(code.trim()).baseName;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a user-supplied `admin.locales` list to the admin's own locale
 * codes. Matching ignores case and surrounding whitespace, the source locale
 * is always included first, and duplicates are dropped. Throws, naming every
 * unrecognized entry and listing the available codes, if any entry does not
 * match an available locale.
 */
export function resolveAdminLocales(requested: unknown, available: Iterable<string>): string[] {
	if (!Array.isArray(requested)) {
		throw new Error("`admin.locales` must be an array of locale codes.");
	}
	const entries: unknown[] = requested;

	const byCanonical = new Map<string, string>();
	for (const code of available) {
		byCanonical.set(canonicalizeLocale(code) ?? code, code);
	}

	const resolved = new Set([SOURCE_LOCALE]);
	const unknownEntries: string[] = [];
	for (const entry of entries) {
		const canonical = typeof entry === "string" ? canonicalizeLocale(entry) : undefined;
		const code = canonical === undefined ? undefined : byCanonical.get(canonical);
		if (code === undefined) {
			unknownEntries.push(String(JSON.stringify(entry)));
		} else {
			resolved.add(code);
		}
	}

	if (unknownEntries.length > 0) {
		const availableCodes = [...byCanonical.values()].toSorted().join(", ");
		throw new Error(
			`Unknown admin locale${unknownEntries.length === 1 ? "" : "s"} in \`admin.locales\`: ` +
				`${unknownEntries.join(", ")}. Available locales: ${availableCodes}.`,
		);
	}

	return [...resolved];
}

function toVitePath(path: string): string {
	return path.replaceAll("\\", "/");
}

interface AdminLocaleResolverOptions {
	adminDistPath: string;
	/** Set in dev when the admin package is aliased to its source. */
	adminSourcePath?: string;
	locales: readonly string[];
	manifest: AdminLocaleManifest;
}

/**
 * Vite plugin that resolves imports of excluded admin catalogs to the source
 * locale's catalog, so the excluded catalogs are never bundled. Covers both
 * the built admin package (hashed chunks listed in the manifest) and, in dev,
 * the admin source (`./<code>/messages.mjs`).
 */
export function createAdminLocaleResolverPlugin(options: AdminLocaleResolverOptions): Plugin {
	const { manifest } = options;
	const sourceLocaleChunk = manifest[SOURCE_LOCALE];
	if (sourceLocaleChunk === undefined) {
		throw new Error(`The admin locale manifest has no "${SOURCE_LOCALE}" catalog.`);
	}

	const allowed = new Set(options.locales);
	const distDir = toVitePath(options.adminDistPath);
	const sourceDir = options.adminSourcePath ? toVitePath(options.adminSourcePath) : undefined;
	const redirects = new Map<string, string>();
	for (const [code, chunk] of Object.entries(manifest)) {
		if (code === SOURCE_LOCALE || allowed.has(code)) continue;
		redirects.set(posix.join(distDir, chunk), posix.join(distDir, sourceLocaleChunk));
		if (sourceDir) {
			redirects.set(
				posix.join(sourceDir, "locales", code, "messages.mjs"),
				posix.join(distDir, "locales", SOURCE_LOCALE, "messages.mjs"),
			);
		}
	}

	return {
		name: "emdash-admin-locales",
		enforce: "pre",
		resolveId(source, importer) {
			if (!importer || !source.startsWith(".")) return;
			const importerDir = posix.dirname(toVitePath(importer).replace(QUERY_RE, ""));
			return redirects.get(posix.join(importerDir, source.replace(QUERY_RE, "")));
		},
	};
}
