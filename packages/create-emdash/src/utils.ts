import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const PROJECT_NAME_PATTERN = /^[a-z0-9-]+$/;
const INVALID_PKG_NAME_CHARS = /[^a-z0-9-]/g;
const LEADING_TRAILING_HYPHENS = /^-+|-+$/g;

/**
 * Generate a fresh `EMDASH_ENCRYPTION_KEY` value.
 *
 * Format mirrors `packages/core/src/config/secrets.ts` (`emdash_enc_v1_`
 * followed by 32 random bytes encoded as unpadded base64url, 43 chars).
 *
 * Vendored here rather than imported from `emdash` so create-emdash stays
 * a small standalone package — the core package is not yet installed at
 * scaffold time.
 */
export function generateEncryptionKey(): string {
	const body = randomBytes(32).toString("base64url");
	return `emdash_enc_v1_${body}`;
}

/** Matches a populated entry — `KEY=<at least one char>`. */
const POPULATED_KEY_LINE_PATTERN = /^EMDASH_ENCRYPTION_KEY=.+$/m;
/** Matches any entry (including `KEY=` empty value), for in-place replace. */
const ANY_KEY_LINE_PATTERN = /^EMDASH_ENCRYPTION_KEY=.*$/m;

/**
 * Write `EMDASH_ENCRYPTION_KEY=...` into a dotenv-style local-secrets file
 * (`.dev.vars` for Workers, `.env` for Node).
 *
 * Idempotent: if the entry exists with a populated value, leaves it alone.
 * An entry with an empty value (`EMDASH_ENCRYPTION_KEY=`, e.g. a placeholder
 * copied from `.env.example`) is treated as not-set and gets replaced.
 *
 * Returns `"wrote"` if a new entry was added or an empty placeholder was
 * filled in, `"skipped"` if an existing populated entry was found.
 *
 * Mirrors `writeEncryptionKeyToFile` in `packages/core/src/cli/commands/secrets.ts`.
 * Vendored for the same reason as `generateEncryptionKey` — create-emdash
 * doesn't depend on the emdash core package.
 */
export function writeEncryptionKey(projectDir: string, fileName: string): "wrote" | "skipped" {
	const target = resolve(projectDir, fileName);
	const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
	if (POPULATED_KEY_LINE_PATTERN.test(existing)) {
		return "skipped";
	}
	const value = generateEncryptionKey();
	const newLine = `EMDASH_ENCRYPTION_KEY=${value}`;
	let next: string;
	if (ANY_KEY_LINE_PATTERN.test(existing)) {
		next = existing.replace(ANY_KEY_LINE_PATTERN, newLine);
		if (!next.endsWith("\n")) next += "\n";
	} else {
		const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "" : "\n";
		next = `${existing}${sep}${newLine}\n`;
	}
	writeFileSync(target, next);
	return "wrote";
}

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
