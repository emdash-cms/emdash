/**
 * emdash schema
 *
 * Manage collections and fields via the remote API
 */

import { defineCommand } from "citty";
import { consola } from "consola";

import { connectionArgs as commonArgs, createClientFromArgs } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";

const listCommand = defineCommand({
	meta: {
		name: "list",
		description: "List all collections",
	},
	args: {
		...commonArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const collections = await client.collections();
			output(collections, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const getCommand = defineCommand({
	meta: {
		name: "get",
		description: "Get collection with fields",
	},
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		...commonArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const collection = await client.collection(args.collection);
			output(collection, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const createCommand = defineCommand({
	meta: {
		name: "create",
		description: "Create a collection",
	},
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		label: {
			type: "string",
			description: "Collection label",
			required: true,
		},
		"label-singular": {
			type: "string",
			description: "Singular label (defaults to label)",
		},
		description: {
			type: "string",
			description: "Collection description",
		},
		...commonArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const data = await client.createCollection({
				slug: args.collection,
				label: args.label,
				labelSingular: args["label-singular"] || args.label,
				description: args.description,
			});
			consola.success(`Created collection "${args.collection}"`);
			output(data, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const deleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a collection",
	},
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		force: {
			type: "boolean",
			description: "Skip confirmation",
		},
		...commonArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			if (!args.force) {
				const confirmed = await consola.prompt(`Delete collection "${args.collection}"?`, {
					type: "confirm",
				});
				if (!confirmed) {
					consola.info("Cancelled");
					return;
				}
			}
			const client = createClientFromArgs(args);
			await client.deleteCollection(args.collection);
			consola.success(`Deleted collection "${args.collection}"`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const addFieldCommand = defineCommand({
	meta: {
		name: "add-field",
		description: "Add a field to a collection",
	},
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		field: {
			type: "positional",
			description: "Field slug",
			required: true,
		},
		type: {
			type: "string",
			description:
				"Field type (string, text, number, integer, boolean, datetime, image, reference, portableText, json)",
			required: true,
		},
		label: {
			type: "string",
			description: "Field label",
		},
		required: {
			type: "boolean",
			description: "Whether the field is required",
		},
		...commonArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const data = await client.createField(args.collection, {
				slug: args.field,
				type: args.type,
				label: args.label || args.field,
				required: args.required,
			});
			consola.success(`Added field "${args.field}" to "${args.collection}"`);
			output(data, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const removeFieldCommand = defineCommand({
	meta: {
		name: "remove-field",
		description: "Remove a field from a collection",
	},
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		field: {
			type: "positional",
			description: "Field slug",
			required: true,
		},
		...commonArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			await client.deleteField(args.collection, args.field);
			consola.success(`Removed field "${args.field}" from "${args.collection}"`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

export const schemaCommand = defineCommand({
	meta: {
		name: "schema",
		description: "Manage collections and fields",
	},
	subCommands: {
		list: listCommand,
		get: getCommand,
		create: createCommand,
		delete: deleteCommand,
		"add-field": addFieldCommand,
		"remove-field": removeFieldCommand,
	},
});
