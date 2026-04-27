import { readdirSync } from "node:fs";

export const PROJECT_NAME_PATTERN = /^[a-z0-9-]+$/;
const INVALID_PKG_NAME_CHARS = /[^a-z0-9-]/g;
const LEADING_TRAILING_HYPHENS = /^-+|-+$/g;

/** Sanitise a directory basename into a valid npm package name */
export function sanitizePackageName(name: string): string {
	return (
		name.toLowerCase().replace(INVALID_PKG_NAME_CHARS, "-").replace(LEADING_TRAILING_HYPHENS, "") ||
		"my-site"
	);
}

/** Check whether a directory exists and contains files */
export function isDirNonEmpty(dir: string): boolean {
	try {
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

/**
 * Parse the first positional argument (not a flag) from an argv array.
 * Returns undefined if no positional argument is found.
 */
export function parseTargetArg(argv: string[]): string | undefined {
	return argv.slice(2).find((a) => !a.startsWith("-"));
}
