/**
 * Auth CLI commands (deprecated)
 *
 * Kept as a deprecated alias for backwards compatibility. The original
 * `emdash auth secret` was documented in published docs and is plausibly
 * scripted in user CI (e.g. `npx emdash auth secret >> .env`). Removing
 * it outright would break those scripts on minor-version upgrade.
 *
 * The command still emits an `EMDASH_AUTH_SECRET=<32-byte-base64url>`
 * line, unchanged. `EMDASH_AUTH_SECRET` itself is now legacy: it's only
 * read as a fallback source for the commenter-IP hash salt so installs
 * upgrading from a prior version keep stable IP hashes (and therefore
 * stable rate-limit buckets). New installs don't need to set it.
 *
 * The deprecation note steers users toward `emdash secrets generate`
 * (which emits a different, versioned `emdash_enc_v1_*` value for
 * `EMDASH_ENCRYPTION_KEY` — used to encrypt plugin secrets at rest).
 *
 * Will be removed in a future minor.
 */

import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import { encodeBase64url } from "../../utils/base64.js";

function generateAuthSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return encodeBase64url(bytes);
}

const secretCommand = defineCommand({
	meta: {
		name: "secret",
		description: "[DEPRECATED] Generate a value for legacy EMDASH_AUTH_SECRET",
	},
	run() {
		const secret = generateAuthSecret();

		// Match the original behavior verbatim: pretty-printed name=value
		// on stdout (most scripts piped this to a file expecting that shape).
		consola.log("");
		consola.log(pc.bold("Generated auth secret:"));
		consola.log("");
		consola.log(`  ${pc.cyan("EMDASH_AUTH_SECRET")}=${pc.green(secret)}`);
		consola.log("");
		consola.log(pc.dim("Add this to your environment variables."));
		consola.log("");
		// Deprecation note on stderr so it doesn't break stdout consumers.
		process.stderr.write(
			`${pc.yellow("Note:")} ${pc.bold("emdash auth secret")} is deprecated and will be removed in a future minor. ` +
				`${pc.cyan("EMDASH_AUTH_SECRET")} itself is now optional — it's only used as a legacy fallback for the commenter-IP hash salt. ` +
				`For encrypting plugin secrets at rest, use ${pc.bold("emdash secrets generate")} (a different secret: ${pc.cyan("EMDASH_ENCRYPTION_KEY")}).\n`,
		);
	},
});

export const authCommand = defineCommand({
	meta: {
		name: "auth",
		description: "[DEPRECATED] Authentication utilities (use `emdash secrets` for new flows)",
	},
	subCommands: {
		secret: secretCommand,
	},
});
