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
 * (`.env` — read by Node and, in local dev, by Wrangler / the Cloudflare
 * Vite plugin).
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

/**
 * Canonical single-line form of the Cloudflare Worker Loader binding.
 *
 * Worker Loader ("dynamic workers") is a Workers *paid-plan* feature used only
 * for dynamic plugins (marketplace + sandboxed plugins). Templates ship with
 * this commented out so free-tier deploys succeed; the scaffolder uncomments it
 * when the user opts in.
 */
const WORKER_LOADER_LINE = `"worker_loaders": [{ "binding": "LOADER" }],`;
const WORKER_LOADER_COMMENT =
	"Dynamic plugins need the Cloudflare Workers paid plan (Worker Loader).";

/** The worker_loaders key line, whether commented or not. */
const WORKER_LOADER_DECL = /^(\s*)(?:\/\/\s*)?"worker_loaders"\s*:/;
/** A preceding comment line that belongs to the worker_loaders block. */
const WORKER_LOADER_OWN_COMMENT = /^\s*\/\/.*worker loader/i;
/** Split on either Unix or Windows line endings. */
const NEWLINE_SPLIT = /\r?\n/;

/**
 * Enable or disable the Worker Loader binding in a project's `wrangler.jsonc`.
 *
 * Normalises whatever form is present — the legacy multi-line block that older
 * published templates carry, or the canonical single-line form — into the
 * requested state. Disabling comments the binding out (free-tier safe);
 * enabling leaves an active single-line declaration.
 *
 * Idempotent, and a no-op returning `"absent"` when there is no
 * `wrangler.jsonc` (Node templates) or no `worker_loaders` declaration.
 */
export function setWorkerLoader(
	projectDir: string,
	enabled: boolean,
): "enabled" | "disabled" | "absent" {
	const target = resolve(projectDir, "wrangler.jsonc");
	if (!existsSync(target)) return "absent";

	const original = readFileSync(target, "utf-8");
	const newline = original.includes("\r\n") ? "\r\n" : "\n";
	const lines = original.split(NEWLINE_SPLIT);

	const declIdx = lines.findIndex((line) => WORKER_LOADER_DECL.test(line));
	if (declIdx === -1) return "absent";

	// Extend past a legacy multi-line block: the array value spans until a line
	// whose trimmed content starts with the closing "]". A single-line form has
	// the "]" on the declaration line itself.
	let endIdx = declIdx;
	if (!lines[declIdx].includes("]")) {
		while (endIdx < lines.length - 1 && !lines[endIdx].trim().startsWith("]")) {
			endIdx++;
		}
	}

	// Absorb a single immediately-preceding comment line that belongs to the
	// block (legacy "// Worker Loader for plugin sandboxing" or our own).
	let startIdx = declIdx;
	if (declIdx > 0 && WORKER_LOADER_OWN_COMMENT.test(lines[declIdx - 1])) {
		startIdx = declIdx - 1;
	}

	const indent = WORKER_LOADER_DECL.exec(lines[declIdx])?.[1] ?? "\t";
	const replacement = enabled
		? [`${indent}// ${WORKER_LOADER_COMMENT}`, `${indent}${WORKER_LOADER_LINE}`]
		: [
				`${indent}// ${WORKER_LOADER_COMMENT} Uncomment to enable:`,
				`${indent}// ${WORKER_LOADER_LINE}`,
			];

	lines.splice(startIdx, endIdx - startIdx + 1, ...replacement);
	writeFileSync(target, lines.join(newline));
	return enabled ? "enabled" : "disabled";
}
