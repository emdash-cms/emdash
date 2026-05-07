/**
 * `emdash-registry whoami`
 *
 * Show the active publisher session, plus a short list of any other stored
 * sessions. Read-only: this command never refreshes tokens or hits the network.
 */

import { FileCredentialStore } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

export const whoamiCommand = defineCommand({
	meta: {
		name: "whoami",
		description: "Show the active publisher and any other stored sessions",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
		},
	},
	async run({ args }) {
		const credentials = new FileCredentialStore();
		const current = await credentials.current();
		const all = await credentials.list();

		if (args.json) {
			console.log(
				JSON.stringify({
					current: current ?? null,
					sessions: all,
				}),
			);
			return;
		}

		if (!current) {
			consola.info("Not logged in. Run: emdash-registry login <handle-or-did>");
			return;
		}

		consola.info(`Active publisher: ${pc.bold(current.handle ?? current.did)}`);
		consola.info(`DID:              ${pc.dim(current.did)}`);
		if (current.pds) consola.info(`PDS:              ${pc.dim(current.pds)}`);

		const others = all.filter((s) => s.did !== current.did);
		if (others.length > 0) {
			console.log();
			consola.info(`Other stored sessions (${others.length}):`);
			for (const s of others) {
				console.log(`  ${pc.dim(s.handle ?? s.did)} (${pc.dim(s.did)})`);
			}
			console.log();
			consola.info(`Switch with: ${pc.cyan("emdash-registry switch <did>")}`);
		}
	},
});
