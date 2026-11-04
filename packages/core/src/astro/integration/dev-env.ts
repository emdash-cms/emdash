import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_ENV_SECRET_VAR_NAMES = new Set(["EMDASH_ENCRYPTION_KEY"]);
const NEWLINE_RE = /\r?\n/;

/**
 * Parse a minimal subset of dotenv syntax, enough for the local secrets
 * scaffolder and common user edits. Inline comments, blank lines, and
 * lines without an `=` are ignored; leading/trailing whitespace is trimmed.
 * Single and double quotes are stripped; no variable expansion is performed.
 */
function parseDotenv(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of content.split(NEWLINE_RE)) {
		const line = stripInlineComment(rawLine).trim();
		if (line === "" || line.startsWith("#")) continue;

		const eq = line.indexOf("=");
		if (eq === -1) continue;

		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();

		// Strip matching quote pair. Keep escaped quotes simple: only unescape
		// the quote char that wrapped the value.
		if (value.length >= 2) {
			const first = value[0];
			const last = value.at(-1)!;
			if ((first === '"' || first === "'") && first === last) {
				value = value.slice(1, -1).replaceAll(`\\${first}`, first);
			}
		}

		result[key] = value;
	}
	return result;
}

/**
 * Remove an inline `#` comment only if it is not inside a quoted value. This
 * keeps values like `FOO="a # b"` intact while stripping trailing comments.
 */
function stripInlineComment(line: string): string {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
		} else if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
		} else if (char === "#" && !inSingleQuote && !inDoubleQuote) {
			return line.slice(0, i);
		}
	}
	return line;
}

/**
 * Load the plugin-secret encryption key from the project's `.env` into
 * `process.env` during `astro dev`. Existing environment variables (e.g.
 * already exported in the shell, or set by the host platform) are honored and
 * never overwritten.
 *
 * This keeps the deliberate `process.env`-only rule in the secrets module
 * while letting freshly scaffolded Node sites use the generated encryption key
 * without a manual `export` step. Other EmDash variables are intentionally not
 * copied, so `.env` values intended for production do not accidentally replace
 * generated dev values (for example `SITE_URL`).
 */
export function loadDevEnv(root: URL | string): void {
	const rootPath = typeof root === "string" ? root : fileURLToPath(root);
	const envPath = join(rootPath, ".env");
	if (!existsSync(envPath)) return;

	const parsed = parseDotenv(readFileSync(envPath, "utf-8"));
	for (const [key, value] of Object.entries(parsed)) {
		if (DEV_ENV_SECRET_VAR_NAMES.has(key) && !process.env[key]) {
			process.env[key] = value;
		}
	}
}
