/**
 * `emdash-registry publish` — STUB.
 *
 * Publishing a release ties together: bundle resolution (the existing `emdash
 * plugin bundle` pipeline), checksum computation, manifest reading, profile
 * record bootstrapping, and release record creation. That is meaningful work
 * and gets its own follow-up PR; this stub exists so the command tree is
 * complete and so users get a clear "not yet" message instead of an unknown
 * subcommand error.
 *
 * Until publishing is implemented, plugin authors should continue using the
 * legacy `emdash plugin publish` flow against marketplace.emdashcms.com.
 */

import { defineCommand } from "citty";
import { consola } from "consola";

export const publishCommand = defineCommand({
	meta: {
		name: "publish",
		description: "Publish a plugin release to the registry (NOT YET IMPLEMENTED)",
	},
	async run() {
		consola.warn(
			"`emdash-registry publish` is not implemented yet. The bundle + atproto write path lands in a follow-up PR.",
		);
		consola.info(
			"Until then, use the legacy marketplace flow: `emdash plugin publish` (GitHub-device-flow auth).",
		);
		process.exit(2);
	},
});
