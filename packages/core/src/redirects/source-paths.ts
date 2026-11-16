import { normalizeSourcePath } from "./patterns.js";

function withoutOneTrailingSlash(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function withTrailingSlashVariants(path: string): string[] {
	const bare = withoutOneTrailingSlash(path);
	return bare === "/" ? [bare] : [bare, `${bare}/`];
}

function percentEscapeCaseVariants(path: string): string[] {
	return [
		path,
		path.replace(/%[a-f\d]{2}/gi, (escape) => escape.toUpperCase()),
		path.replace(/%[a-f\d]{2}/gi, (escape) => escape.toLowerCase()),
	];
}

/** Return whether URL normalization removes a slash-delimited path segment. */
export function normalizationDropsSegments(path: string): boolean {
	const raw = withoutOneTrailingSlash(path);
	const normalized = withoutOneTrailingSlash(normalizeSourcePath(path));
	let rawSlashes = 0;
	let normalizedSlashes = 0;
	for (let index = 0; index < raw.length; index++) {
		if (raw[index] === "/") rawSlashes++;
	}
	for (let index = 0; index < normalized.length; index++) {
		if (normalized[index] === "/") normalizedSlashes++;
	}
	return normalizedSlashes < rawSlashes;
}

/**
 * Return the stable source spelling used for an imported redirect.
 *
 * A normalization which removes a segment must not turn an imported source
 * into a parent path. Otherwise, a path such as /%252e/posts could shadow
 * /posts. The second normalization check re-escapes non-idempotent keys so
 * layered percent escapes remain distinct when they are stored.
 */
export function canonicalImportSource(path: string): string {
	const raw = withoutOneTrailingSlash(path);
	const key = normalizeSourcePath(raw);
	if (normalizationDropsSegments(raw)) return raw;
	if (normalizeSourcePath(key) === key) return key;
	try {
		return encodeURI(key);
	} catch {
		return raw;
	}
}

/** Return bounded indexed lookup spellings for canonical imported sources. */
export function importSourceLookupVariants(rawPaths: Iterable<string>): string[] {
	const variants = new Set<string>();
	for (const raw of rawPaths) {
		const candidates = [
			...withTrailingSlashVariants(raw),
			...withTrailingSlashVariants(canonicalImportSource(raw)),
		];
		if (!normalizationDropsSegments(raw)) {
			candidates.push(...withTrailingSlashVariants(normalizeSourcePath(raw)));
		}
		for (const candidate of candidates) {
			for (const spelling of percentEscapeCaseVariants(candidate)) {
				if (importSourceKey(spelling) === importSourceKey(raw)) variants.add(spelling);
			}
		}
	}
	return [...variants];
}

/** Return the normalized, slash-insensitive key used for comparing sources. */
export function importSourceKey(path: string): string {
	return withoutOneTrailingSlash(normalizeSourcePath(path));
}
