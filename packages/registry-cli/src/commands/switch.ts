/**
 * `emdash-registry switch <did>`
 *
 * Change the active publisher session. The DID must already be in the
 * credentials store (i.e. you've previously logged in as it). Use
 * `emdash-registry whoami` to see stored sessions.
 *
 * The OAuth library still resolves a refreshed access token by DID on the
 * next publish; this command only changes which DID is "current" for the
 * convenience of subsequent commands.
 */

import { isDid } from "@atcute/lexicons/syntax";
import { FileCredentialStore } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

export const switchCommand = defineCommand({
	meta: {
		name: "switch",
		description: "Switch the active publisher session to another stored DID",
	},
	args: {
		did: {
			type: "positional",
			description: "DID to switch to. Must already be in the credentials store.",
			required: true,
		},
	},
	async run({ args }) {
		if (!isDid(args.did)) {
			consola.error(`"${args.did}" is not a valid DID`);
			process.exit(2);
		}

		const credentials = new FileCredentialStore();
		const target = await credentials.get(args.did);
		if (!target) {
			consola.error(
				`No stored session for ${args.did}. Run: emdash-registry whoami to list stored sessions.`,
			);
			process.exit(1);
		}

		await credentials.setCurrent(args.did);
		consola.success(
			`Active publisher is now ${pc.bold(target.handle ?? target.did)} (${pc.dim(target.did)})`,
		);
	},
});
