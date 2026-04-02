/**
 * emdash taxonomy
 *
 * Manage taxonomies and terms via the EmDash REST API.
 */

import { defineCommand } from "citty";
import { consola } from "consola";

import { connectionArgs, createClientFromArgs } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";

/** Pattern to replace whitespace with hyphens for slug generation */
const WHITESPACE_PATTERN = /\s+/g;

const listCommand = defineCommand({
	meta: {
		name: "list",
		description: "List all taxonomies",
	},
	args: {
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const taxonomies = await client.taxonomies();
			output(taxonomies, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const termsCommand = defineCommand({
	meta: {
		name: "terms",
		description: "List terms in a taxonomy",
	},
	args: {
		name: {
			type: "positional",
			description: "Taxonomy name",
			required: true,
		},
		limit: {
			type: "string",
			alias: "l",
			description: "Maximum terms to return",
		},
		cursor: {
			type: "string",
			description: "Pagination cursor",
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const result = await client.terms(args.name, {
				limit: args.limit ? parseInt(args.limit, 10) : undefined,
				cursor: args.cursor,
			});
			output(result, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const addTermCommand = defineCommand({
	meta: {
		name: "add-term",
		description: "Create a term in a taxonomy",
	},
	args: {
		taxonomy: {
			type: "positional",
			description: "Taxonomy name",
			required: true,
		},
		name: {
			type: "string",
			description: "Term label",
			required: true,
		},
		slug: {
			type: "string",
			description: "Term slug (defaults to slugified name)",
		},
		parent: {
			type: "string",
			description: "Parent term ID",
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const label = args.name;
			const slug = args.slug || label.toLowerCase().replace(WHITESPACE_PATTERN, "-");
			const term = await client.createTerm(args.taxonomy, {
				slug,
				label,
				parentId: args.parent,
			});
			consola.success(`Created term "${label}" in ${args.taxonomy}`);
			output(term, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

export const taxonomyCommand = defineCommand({
	meta: {
		name: "taxonomy",
		description: "Manage taxonomies and terms",
	},
	subCommands: {
		list: listCommand,
		terms: termsCommand,
		"add-term": addTermCommand,
	},
});
