import { normalizeRedirectPath, normalizeSourcePath } from "./patterns.js";

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

/** Return whether normalization changes the decoded pathname, beyond URI escaping. */
export function normalizationChangesPath(path: string): boolean {
	if (path.includes("?") || path.includes("#")) return false;
	try {
		const decoded = decodeURI(path);
		const preserved = new URL("http://placeholder.invalid");
		// Shield literal percent sequences so decoding the serialized path cannot
		// consume another encoding layer while detecting stripped or rewritten characters.
		preserved.pathname = decoded.replaceAll("%", "%25");
		return (
			decodeURI(preserved.pathname) !== decoded ||
			preserved.pathname.replaceAll("%25", "%") !== normalizeSourcePath(path)
		);
	} catch {
		// normalizeSourcePath also leaves invalid encodings unchanged.
		return false;
	}
}

/**
 * Return the stable source spelling used for an imported redirect.
 *
 * Normalization must not turn an imported source into another pathname. The
 * second normalization check re-escapes non-idempotent keys so layered
 * percent escapes remain distinct when they are stored.
 */
export function canonicalImportSource(path: string): string {
	const raw = withoutOneTrailingSlash(path);
	const key = normalizeRedirectPath(raw);
	if (normalizationChangesPath(raw)) return raw;
	if (normalizeRedirectPath(key) === key) return key;
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
		if (!normalizationChangesPath(raw)) {
			candidates.push(
				...withTrailingSlashVariants(normalizeRedirectPath(raw)),
				...withTrailingSlashVariants(normalizeSourcePath(raw)),
			);
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
	return withoutOneTrailingSlash(normalizeRedirectPath(path));
}
