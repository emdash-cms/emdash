/**
 * `emdash-registry search <query> [--capability <name>] [--limit <n>] [--cursor <c>]`
 *
 * Free-text search the aggregator. Read-only; no auth required.
 */

import { DiscoveryClient } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import { resolveAggregatorUrl } from "../config.js";

export const searchCommand = defineCommand({
	meta: {
		name: "search",
		description: "Search the plugin registry by free-text query",
	},
	args: {
		query: {
			type: "positional",
			description: "Search query (matches name, description, keywords, authors)",
			required: true,
		},
		capability: {
			type: "string",
			description: "Filter to packages declaring this access category (e.g. 'email', 'network')",
		},
		limit: {
			type: "string",
			description: "Max results per page (1-100, default 25)",
			default: "25",
		},
		cursor: {
			type: "string",
			description:
				"Continuation cursor from a previous search result (printed at the end when more results exist)",
		},
		aggregator: {
			type: "string",
			description: "Override aggregator URL (defaults to EMDASH_REGISTRY_URL or experimental host)",
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
		},
	},
	async run({ args }) {
		const aggregatorUrl = resolveAggregatorUrl(args.aggregator);
		const limit = clamp(parseInt(args.limit, 10) || 25, 1, 100);

		const client = new DiscoveryClient({ aggregatorUrl });
		const result = await client.searchPackages({
			q: args.query,
			...(args.capability ? { capability: args.capability } : {}),
			...(args.cursor ? { cursor: args.cursor } : {}),
			limit,
		});

		if (args.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		if (result.packages.length === 0) {
			consola.info(`No packages match "${args.query}".`);
			return;
		}

		console.log();
		for (const pkg of result.packages) {
			const profile = pkg.profile as { name?: string; description?: string };
			console.log(`${pc.bold(profile.name ?? pkg.slug)} ${pc.dim(`(${pkg.slug})`)}`);
			if (profile.description) console.log(`  ${profile.description}`);
			console.log(`  ${pc.dim(pkg.uri)}`);
			console.log();
		}

		if (result.cursor) {
			// Cursor-based pagination: callers paginate by passing the cursor
			// back in, not by bumping --limit. The aggregator caps `limit` at
			// 100, so suggesting "increase the limit" was misleading advice.
			consola.info(
				`More results available. Continue with: ${pc.cyan(
					`emdash-registry search "${args.query}" --cursor ${result.cursor}`,
				)}`,
			);
		}
	},
});

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}
