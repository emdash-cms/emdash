/**
 * emdash content
 *
 * CRUD commands for managing content items via the EmDash REST API.
 */

import { readFile } from "node:fs/promises";

import { defineCommand } from "citty";
import { consola } from "consola";

import { connectionArgs, createClientFromArgs } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read content data from --data, --file, or --stdin */
async function readInputData(args: {
	data?: string;
	file?: string;
	stdin?: boolean;
}): Promise<Record<string, unknown>> {
	if (args.data) {
		try {
			return JSON.parse(args.data) as Record<string, unknown>;
		} catch {
			throw new Error("Invalid JSON in --data argument");
		}
	}

	if (args.file) {
		try {
			const content = await readFile(args.file, "utf-8");
			return JSON.parse(content) as Record<string, unknown>;
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new Error(`Invalid JSON in file: ${args.file}`, { cause: error });
			}
			throw error;
		}
	}

	if (args.stdin) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(chunk as Buffer);
		}
		const content = Buffer.concat(chunks).toString("utf-8");
		try {
			return JSON.parse(content) as Record<string, unknown>;
		} catch {
			throw new Error("Invalid JSON from stdin");
		}
	}

	throw new Error("Provide content data via --data, --file, or --stdin");
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const listCommand = defineCommand({
	meta: { name: "list", description: "List content items" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		status: { type: "string", description: "Filter by status" },
		locale: { type: "string", description: "Filter by locale" },
		limit: { type: "string", description: "Maximum items to return" },
		cursor: { type: "string", description: "Pagination cursor" },
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const result = await client.list(args.collection, {
				status: args.status,
				locale: args.locale,
				limit: args.limit ? parseInt(args.limit, 10) : undefined,
				cursor: args.cursor,
			});
			// Summarize items — strip heavy data fields for readable output
			const summary = {
				items: result.items.map((item) => ({
					id: item.id,
					slug: item.slug,
					locale: item.locale,
					status: item.status,
					title: typeof item.data?.title === "string" ? item.data.title : undefined,
					updatedAt: item.updatedAt,
				})),
				nextCursor: result.nextCursor,
			};
			output(summary, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const getCommand = defineCommand({
	meta: { name: "get", description: "Get a single content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		locale: { type: "string", description: "Locale for slug resolution" },
		raw: {
			type: "boolean",
			description: "Return raw Portable Text (skip markdown conversion)",
		},
		published: {
			type: "boolean",
			description: "Return published data only (ignore pending draft)",
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const item = await client.get(args.collection, args.id, {
				raw: args.raw,
				locale: args.locale,
			});

			// If a draft exists, overlay draft data unless --published
			if (!args.published && item.draftRevisionId) {
				const comparison = await client.compare(args.collection, args.id);
				if (comparison.hasChanges && comparison.draft) {
					item.data = comparison.draft;
				}
			}

			output(item, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const createCommand = defineCommand({
	meta: { name: "create", description: "Create a content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		data: { type: "string", description: "Content data as JSON string" },
		file: { type: "string", description: "Read content data from a JSON file" },
		stdin: { type: "boolean", description: "Read content data from stdin" },
		slug: { type: "string", description: "Content slug" },
		locale: { type: "string", description: "Content locale" },
		"translation-of": {
			type: "string",
			description: "ID of content item to link as translation",
		},
		draft: {
			type: "boolean",
			description: "Keep as draft instead of auto-publishing",
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const data = await readInputData(args);
			const client = createClientFromArgs(args);
			const item = await client.create(args.collection, {
				data,
				slug: args.slug,
				locale: args.locale,
				translationOf: args["translation-of"],
			});

			// Auto-publish unless --draft is set
			if (!args.draft) {
				await client.publish(args.collection, item.id);
			}

			// Re-fetch to return the current state
			const result = await client.get(args.collection, item.id);
			output(result, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const updateCommand = defineCommand({
	meta: { name: "update", description: "Update a content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		data: { type: "string", description: "Content data as JSON string" },
		file: { type: "string", description: "Read content data from a JSON file" },
		rev: {
			type: "string",
			description: "Revision token from get (prevents overwriting unseen changes)",
			required: true,
		},
		draft: {
			type: "boolean",
			description: "Keep as draft instead of auto-publishing",
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const data = await readInputData(args);
			const client = createClientFromArgs(args);
			const updated = await client.update(args.collection, args.id, {
				data,
				_rev: args.rev,
			});

			// Auto-publish unless --draft is set.
			// Only publish if the update created a draft revision (i.e. the
			// collection supports revisions and data went to a draft).
			if (!args.draft && updated.draftRevisionId) {
				await client.publish(args.collection, args.id);
			}

			// Re-fetch to return the current state
			const item = await client.get(args.collection, args.id);
			output(item, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const deleteCommand = defineCommand({
	meta: { name: "delete", description: "Delete a content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			await client.delete(args.collection, args.id);
			consola.success(`Deleted ${args.collection}/${args.id}`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const publishCommand = defineCommand({
	meta: { name: "publish", description: "Publish a content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			await client.publish(args.collection, args.id);
			consola.success(`Published ${args.collection}/${args.id}`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const unpublishCommand = defineCommand({
	meta: { name: "unpublish", description: "Unpublish a content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			await client.unpublish(args.collection, args.id);
			consola.success(`Unpublished ${args.collection}/${args.id}`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const scheduleCommand = defineCommand({
	meta: { name: "schedule", description: "Schedule content for publishing" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		at: {
			type: "string",
			description: "ISO 8601 datetime to publish at",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			await client.schedule(args.collection, args.id, { at: args.at });
			consola.success(`Scheduled ${args.collection}/${args.id} for ${args.at}`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const restoreCommand = defineCommand({
	meta: { name: "restore", description: "Restore a trashed content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			await client.restore(args.collection, args.id);
			consola.success(`Restored ${args.collection}/${args.id}`);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

const translationsCommand = defineCommand({
	meta: { name: "translations", description: "List translations for a content item" },
	args: {
		collection: {
			type: "positional",
			description: "Collection slug",
			required: true,
		},
		id: {
			type: "positional",
			description: "Content item ID or slug",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const translations = await client.translations(args.collection, args.id);
			output(translations, args);
		} catch (error) {
			consola.error(error instanceof Error ? error.message : "Unknown error");
			process.exit(1);
		}
	},
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const contentCommand = defineCommand({
	meta: { name: "content", description: "Manage content" },
	subCommands: {
		list: listCommand,
		get: getCommand,
		create: createCommand,
		update: updateCommand,
		delete: deleteCommand,
		publish: publishCommand,
		unpublish: unpublishCommand,
		schedule: scheduleCommand,
		restore: restoreCommand,
		translations: translationsCommand,
	},
});
