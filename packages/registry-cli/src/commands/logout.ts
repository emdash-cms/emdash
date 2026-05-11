/**
 * `emdash-registry logout [--did <did>]`
 *
 * Revoke the active publisher session and remove its stored state.
 *
 * Without `--did`, removes the current session. With `--did`, removes the
 * session for that specific DID (useful if the user has multiple stored).
 */

import { isDid } from "@atcute/lexicons/syntax";
import { FileCredentialStore, type Did } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import { consola } from "consola";

import { revokeSession } from "../oauth.js";

export const logoutCommand = defineCommand({
	meta: {
		name: "logout",
		description: "Log out of the plugin registry, revoking the active publisher session",
	},
	args: {
		did: {
			type: "string",
			description: "Specific DID to log out. Defaults to the current session.",
		},
	},
	async run({ args }) {
		const credentials = new FileCredentialStore();

		let did: Did;
		if (args.did) {
			if (!isDid(args.did)) {
				consola.error(`"${args.did}" is not a valid DID`);
				process.exit(2);
			}
			did = args.did;
		} else {
			const current = await credentials.current();
			if (!current) {
				consola.info("No active session to log out from.");
				return;
			}
			did = current.did;
		}

		await revokeSession(did);
		await credentials.remove(did);

		consola.success(`Logged out: ${did}`);
	},
});
