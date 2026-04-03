/**
 * emdash media
 *
 * Manage media items via the EmDash API
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import { connectionArgs, createClientFromArgs } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";

const listCommand = defineCommand({
	meta: {
		name: "list",
		description: "List media items",
	},
	args: {
		...connectionArgs,
		mime: {
			type: "string",
			description: "Filter by MIME type (e.g., image/png)",
		},
		limit: {
			type: "string",
			description: "Number of items to return",
		},
		cursor: {
			type: "string",
			description: "Pagination cursor",
		},
	},
	async run({ args }) {
		configureOutputMode(args);
		const client = createClientFromArgs(args);

		try {
			const result = await client.mediaList({
				mimeType: args.mime,
				limit: args.limit ? Number(args.limit) : undefined,
				cursor: args.cursor,
			});

			output(result, args);
		} catch (error) {
			consola.error("Failed to list media:", error instanceof Error ? error.message : error);
			process.exit(1);
		}
	},
});

const uploadCommand = defineCommand({
	meta: {
		name: "upload",
		description: "Upload a media file",
	},
	args: {
		file: {
			type: "positional",
			description: "Path to the file to upload",
			required: true,
		},
		...connectionArgs,
		alt: {
			type: "string",
			description: "Alt text for the media item",
		},
		caption: {
			type: "string",
			description: "Caption for the media item",
		},
	},
	async run({ args }) {
		configureOutputMode(args);
		const client = createClientFromArgs(args);
		const filename = basename(args.file);

		consola.start(`Uploading ${filename}...`);

		try {
			const buffer = await readFile(args.file);
			const result = await client.mediaUpload(buffer, filename, {
				alt: args.alt,
				caption: args.caption,
			});

			consola.success(`Uploaded ${filename}`);
			output(result, args);
		} catch (error) {
			consola.error("Failed to upload:", error instanceof Error ? error.message : error);
			process.exit(1);
		}
	},
});

const getCommand = defineCommand({
	meta: {
		name: "get",
		description: "Get a media item",
	},
	args: {
		id: {
			type: "positional",
			description: "Media item ID",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		const client = createClientFromArgs(args);

		try {
			const result = await client.mediaGet(args.id);
			output(result, args);
		} catch (error) {
			consola.error("Failed to get media:", error instanceof Error ? error.message : error);
			process.exit(1);
		}
	},
});

const deleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a media item",
	},
	args: {
		id: {
			type: "positional",
			description: "Media item ID",
			required: true,
		},
		...connectionArgs,
	},
	async run({ args }) {
		configureOutputMode(args);
		const client = createClientFromArgs(args);

		try {
			await client.mediaDelete(args.id);

			if (args.json) {
				output({ deleted: true }, args);
			} else {
				consola.success(`Deleted media item ${args.id}`);
			}
		} catch (error) {
			consola.error("Failed to delete media:", error instanceof Error ? error.message : error);
			process.exit(1);
		}
	},
});

export const mediaCommand = defineCommand({
	meta: {
		name: "media",
		description: "Manage media items",
	},
	subCommands: {
		list: listCommand,
		upload: uploadCommand,
		get: getCommand,
		delete: deleteCommand,
	},
});
