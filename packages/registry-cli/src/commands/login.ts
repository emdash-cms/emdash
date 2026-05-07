/**
 * `emdash-registry login <handle-or-did>`
 *
 * Interactive atproto OAuth login. Spins up a loopback HTTP server, opens the
 * user's browser at the AS authorization URL, awaits the callback, exchanges
 * the code, and persists the resulting session.
 *
 * Records the publisher's DID/handle/PDS into the EmDash credentials store
 * (`~/.emdash/credentials.json` by default) so subsequent registry commands
 * can identify the active publisher without cracking open the OAuth library's
 * `StoredSession`.
 */

import { isHandle } from "@atcute/lexicons/syntax";
import { FileCredentialStore } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import { runInteractiveLogin } from "../oauth.js";
import { resolveAtprotoProfile } from "../profile.js";

export const loginCommand = defineCommand({
	meta: {
		name: "login",
		description: "Log in to the plugin registry via your Atmosphere account (atproto OAuth)",
	},
	args: {
		identifier: {
			type: "positional",
			description: "Your handle (e.g. alice.example.com) or DID",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output result as JSON",
		},
	},
	async run({ args }) {
		const identifier = args.identifier.trim();

		consola.start(`Logging in as ${pc.bold(identifier)}...`);

		const result = await runInteractiveLogin({
			identifier,
			onUrl: (url) => {
				console.log();
				consola.info("Open your browser to:");
				console.log(`  ${pc.cyan(pc.bold(url.toString()))}`);
				console.log();
				consola.info("Waiting for authorization...");
			},
		});

		const { displayName, handle, pds } = await resolveAtprotoProfile(result.session);

		// `resolveAtprotoProfile` falls back to the DID when handle
		// resolution fails. We persist `null` rather than a placeholder so
		// downstream display code can render the DID directly instead of a
		// fake "unknown.invalid"-style handle that misleads users.
		const handleForStorage: string | null = isHandle(handle) ? handle : null;
		const credentials = new FileCredentialStore();
		await credentials.put({
			did: result.did,
			handle: handleForStorage,
			pds,
			updatedAt: Date.now(),
		});

		if (args.json) {
			console.log(
				JSON.stringify({
					did: result.did,
					handle: handleForStorage,
					displayName,
					pds,
				}),
			);
			return;
		}

		consola.success(
			`Logged in as ${pc.bold(handleForStorage ?? result.did)}${displayName ? ` (${displayName})` : ""}`,
		);
		if (handleForStorage) consola.info(`DID: ${pc.dim(result.did)}`);
		if (pds) consola.info(`PDS: ${pc.dim(pds)}`);
	},
});
