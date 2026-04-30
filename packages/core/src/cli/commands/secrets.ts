/**
 * Secrets CLI commands
 *
 * Pure (no-DB) commands for working with EmDash secrets:
 *
 * - `emdash secrets generate` — emits a fresh `EMDASH_ENCRYPTION_KEY`.
 *   Optionally writes it to `.dev.vars` (Workers) or `.env` (Node).
 * - `emdash secrets fingerprint <key>` — prints the kid for a key,
 *   useful in CI for verifying what's been deployed without exposing
 *   the raw value.
 *
 * DB-touching commands (`status`, `migrate`, `rotate`) live elsewhere:
 * the CLI process can't open the production D1/Postgres binding from
 * the operator's machine, so those operations ship as admin HTTP
 * endpoints in a later PR. A thin `--site <url>` wrapper for those
 * endpoints can land alongside.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import { EmDashSecretsError, fingerprintKey, generateEncryptionKey } from "../../config/secrets.js";

const KEY_VAR_NAME = "EMDASH_ENCRYPTION_KEY";
/** Matches a populated entry — `KEY=<at least one char>`. */
const POPULATED_KEY_LINE_PATTERN = /^EMDASH_ENCRYPTION_KEY=.+$/m;
/**
 * Matches any line starting `KEY=` including `KEY=` with empty value.
 * Used for in-place replacement when the entry exists but has no value.
 */
const ANY_KEY_LINE_PATTERN = /^EMDASH_ENCRYPTION_KEY=.*$/m;

/**
 * Append (or replace) `EMDASH_ENCRYPTION_KEY` in a dotenv-style file.
 *
 * Idempotent: if the entry exists with a populated value, leaves it alone
 * (returns `"skipped"`) unless `force` is set. An entry with an empty
 * value (`EMDASH_ENCRYPTION_KEY=`) is treated as "not set" and gets
 * replaced — placeholder lines aren't a reason to refuse.
 *
 * Always ends the resulting file with a trailing newline. Doesn't touch
 * other variables.
 *
 * Exported for tests.
 */
export function writeEncryptionKeyToFile(
	targetPath: string,
	value: string,
	force: boolean,
): "wrote" | "skipped" {
	const exists = existsSync(targetPath);
	const existing = exists ? readFileSync(targetPath, "utf-8") : "";

	const hasPopulatedKey = POPULATED_KEY_LINE_PATTERN.test(existing);
	if (hasPopulatedKey && !force) {
		return "skipped";
	}

	const newLine = `${KEY_VAR_NAME}=${value}`;
	let next: string;
	if (ANY_KEY_LINE_PATTERN.test(existing)) {
		// In-place replace handles both populated-and-forced and empty-value
		// cases. Then ensure trailing newline.
		next = existing.replace(ANY_KEY_LINE_PATTERN, newLine);
		if (!next.endsWith("\n")) next += "\n";
	} else {
		// Append. Insert a separating newline only if the file has content
		// not already ending in one.
		const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "" : "\n";
		next = `${existing}${sep}${newLine}\n`;
	}

	writeFileSync(targetPath, next);
	return "wrote";
}

const generateCommand = defineCommand({
	meta: {
		name: "generate",
		description: "Generate a new EmDash encryption key",
	},
	args: {
		write: {
			type: "string",
			description:
				"Optional path to write the key to (e.g. .dev.vars or .env). " +
				"Won't overwrite an existing entry without --force.",
		},
		force: {
			type: "boolean",
			description: "When used with --write, overwrite an existing entry",
			default: false,
		},
	},
	run({ args }) {
		const value = generateEncryptionKey();

		if (args.write) {
			const targetPath = resolve(process.cwd(), args.write);
			const result = writeEncryptionKeyToFile(targetPath, value, args.force);
			if (result === "skipped") {
				// Idempotent no-op: entry already populated. Exit 0 so chained
				// scripts (`emdash secrets generate --write && pnpm dev`) don't
				// break. Pass --force to replace, with full awareness that
				// existing encrypted secrets become unreadable.
				consola.info(
					`${KEY_VAR_NAME} already set in ${pc.cyan(args.write)}; leaving it alone. ` +
						`Pass ${pc.bold("--force")} to replace it.`,
				);
				return;
			}
			consola.log("");
			consola.log(`${pc.bold("Wrote")} ${pc.cyan(KEY_VAR_NAME)} to ${pc.cyan(args.write)}`);
			consola.log("");
			consola.log(
				pc.yellow(
					"Keep this file out of version control. Losing the key means losing every secret encrypted with it.",
				),
			);
			consola.log("");
			return;
		}

		// Print the key to stdout (one line, no decoration) so it can be
		// piped into env files or secret-management tools without scraping.
		// Explanatory text goes to stderr so it doesn't pollute the pipe.
		process.stdout.write(`${value}\n`);
		const guidance = [
			"",
			pc.bold("EmDash encryption key generated."),
			"",
			`Set ${pc.cyan(KEY_VAR_NAME)} in your environment.`,
			"For Cloudflare deployments, push it to your Worker's secrets.",
			"For Node deployments, add it to your process environment or .env file.",
			"",
			pc.yellow("Keep this value secret. Losing it means losing every secret encrypted with it."),
			"",
		].join("\n");
		process.stderr.write(`${guidance}\n`);
	},
});

const fingerprintCommand = defineCommand({
	meta: {
		name: "fingerprint",
		description: "Print the kid (8-char fingerprint) for an encryption key",
	},
	args: {
		key: {
			type: "positional",
			description: "The full key value (with the emdash_enc_v1_ prefix)",
			required: true,
		},
	},
	async run({ args }) {
		try {
			const kid = await fingerprintKey(args.key);
			// Newline-only on stdout so it pipes cleanly into env/CI logs
			// without leaking the raw key.
			process.stdout.write(`${kid}\n`);
		} catch (error) {
			consola.error(
				error instanceof EmDashSecretsError ? error.message : "Failed to fingerprint key",
			);
			process.exit(1);
		}
	},
});

export const secretsCommand = defineCommand({
	meta: {
		name: "secrets",
		description: "Manage EmDash secrets (generate, inspect)",
	},
	subCommands: {
		generate: generateCommand,
		fingerprint: fingerprintCommand,
	},
});
