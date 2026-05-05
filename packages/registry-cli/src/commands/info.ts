/**
 * `emdash-registry info <handle-or-did> <slug>`
 *
 * Show details about a single package. Read-only; no auth required.
 *
 * The first positional argument can be either a handle (`alice.example.com`)
 * or a DID (`did:plc:abc...`). The aggregator distinguishes via separate XRPC
 * methods -- handle goes through `resolvePackage` (which does the
 * handle-to-DID lookup server-side), DID goes straight to `getPackage`.
 */

import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { DiscoveryClient } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import { resolveAggregatorUrl } from "../config.js";

interface ProfileFields {
	name?: string;
	description?: string;
	license?: string;
}

export const infoCommand = defineCommand({
	meta: {
		name: "info",
		description: "Show details about a single package",
	},
	args: {
		publisher: {
			type: "positional",
			description: "Publisher handle (e.g. alice.example.com) or DID",
			required: true,
		},
		slug: {
			type: "positional",
			description: "Package slug",
			required: true,
		},
		aggregator: {
			type: "string",
			description: "Override aggregator URL",
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
		},
	},
	async run({ args }) {
		const aggregatorUrl = resolveAggregatorUrl(args.aggregator);
		const client = new DiscoveryClient({ aggregatorUrl });

		let result;
		if (isDid(args.publisher)) {
			result = await client.getPackage({ did: args.publisher, slug: args.slug });
		} else if (isHandle(args.publisher)) {
			result = await client.resolvePackage({
				handle: args.publisher,
				slug: args.slug,
			});
		} else {
			consola.error(
				`"${args.publisher}" is not a valid handle or DID. Expected a handle like "alice.example.com" or a DID like "did:plc:abc123..."`,
			);
			process.exit(2);
		}

		if (args.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		const profile = result.profile as ProfileFields;

		console.log();
		console.log(pc.bold(profile.name ?? result.slug));
		if (profile.description) {
			console.log(profile.description);
		}
		console.log();
		console.log(`  Slug:      ${result.slug}`);
		console.log(`  Publisher: ${result.handle ?? result.did}`);
		console.log(`  License:   ${profile.license ?? "unknown"}`);
		if (result.latestVersion) {
			console.log(`  Latest:    ${result.latestVersion}`);
		}
		console.log(`  AT URI:    ${pc.dim(result.uri)}`);
		console.log();

		if (result.labels && result.labels.length > 0) {
			consola.info(`Labels (${result.labels.length}):`);
			for (const label of result.labels) {
				console.log(`  ${pc.yellow(label.val)} ${pc.dim(`(by ${label.src})`)}`);
			}
		}
	},
});
