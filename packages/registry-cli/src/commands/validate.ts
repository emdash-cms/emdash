/**
 * `emdash-registry validate [path]`
 *
 * Validate an `emdash-plugin.jsonc` manifest against the v1 schema.
 *
 * Exit codes:
 *
 *   - 0: manifest is schema-valid.
 *   - 1: validation failed; details on stderr (human mode) or stdout (JSON mode).
 *   - 2: usage error (e.g. invalid `--json` combination).
 *
 * The CLI does not check publish-time invariants here (e.g. license required
 * on first publish vs ignored on subsequent). Those checks live in
 * `publishRelease` and require network access. `validate` is a fast, offline
 * sanity check that's safe to wire into `pre-commit` / CI.
 */

import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { ManifestError, loadManifest, MANIFEST_FILENAME } from "../manifest/load.js";

export const validateCommand = defineCommand({
	meta: {
		name: "validate",
		description:
			"Validate an emdash-plugin.jsonc manifest against the v1 schema (offline; no network access).",
	},
	args: {
		path: {
			type: "positional",
			required: false,
			description: `Path to the manifest, or the directory containing it. Defaults to ./${MANIFEST_FILENAME}.`,
		},
		json: {
			type: "boolean",
			description:
				"Emit machine-readable JSON instead of human-readable output. Stdout is { ok: true, path } or { ok: false, error: { code, message, issues } }. Exit code mirrors human mode.",
		},
	},
	async run({ args }) {
		const path = args.path ?? ".";
		try {
			const { path: resolved } = await loadManifest(path);

			if (args.json) {
				process.stdout.write(`${JSON.stringify({ ok: true, path: resolved })}\n`);
				return;
			}

			consola.success(`Manifest is valid: ${pc.dim(resolved)}`);
		} catch (error) {
			if (error instanceof ManifestError) {
				if (args.json) {
					process.stdout.write(
						`${JSON.stringify({
							ok: false,
							error: {
								code: error.code,
								message: error.message,
								path: error.path,
								issues: error.issues,
							},
						})}\n`,
					);
				} else {
					consola.error(error.message);
				}
				process.exit(1);
			}
			throw error;
		}
	},
});
