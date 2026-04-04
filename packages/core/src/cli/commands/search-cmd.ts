/**
 * emdash search
 *
 * Full-text search across content
 */

import { defineCommand } from "citty";
import { consola } from "consola";

import { connectionArgs, createClientFromArgs } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";

export const searchCommand = defineCommand({
	meta: {
		name: "search",
		description: "Full-text search across content",
	},
	args: {
		query: {
			type: "positional",
			description: "Search query",
			required: true,
		},
		collection: {
			type: "string",
			alias: "c",
			description: "Filter by collection",
		},
		locale: {
			type: "string",
			description: "Filter by locale",
		},
		limit: {
			type: "string",
			alias: "l",
			description: "Maximum results to return",
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const results = await client.search(args.query, {
				collection: args.collection,
				locale: args.locale,
				limit: args.limit ? parseInt(args.limit, 10) : undefined,
			});
			output(results, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});
