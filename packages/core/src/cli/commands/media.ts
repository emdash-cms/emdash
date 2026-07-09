/**
 * emdash media
 *
 * Manage media items via the EmDash API
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import type { MediaUsageRepairResponse } from "../../client/index.js";
import { connectionArgs, createClientFromArgs } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";

const repairScopeError = "Specify exactly one of --collection or --all";

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

const repairUsageCommand = defineCommand({
	meta: {
		name: "repair-usage",
		description: "Repair content media usage indexes",
	},
	args: {
		...connectionArgs,
		collection: {
			type: "string",
			alias: "c",
			description: "Repair one content collection",
		},
		all: {
			type: "boolean",
			description: "Repair every content collection",
		},
	},
	async run({ args }) {
		configureOutputMode(args);

		const hasCollection = typeof args.collection === "string";
		const hasAll = args.all === true;
		if (hasCollection === hasAll) {
			consola.error(repairScopeError);
			process.exit(1);
		}

		const client = createClientFromArgs(args);

		try {
			const result = await client.mediaRepairUsage(
				hasCollection ? { scope: "collection", collection: args.collection } : { scope: "all" },
			);

			if (args.json || !process.stdout.isTTY) {
				output(result, args);
			} else {
				printRepairUsageSummary(result);
			}

			if (result.status === "failed") {
				process.exitCode = 1;
			}
		} catch (error) {
			consola.error(
				"Failed to repair media usage:",
				error instanceof Error ? error.message : error,
			);
			process.exit(1);
		}
	},
});

function printRepairUsageSummary(result: MediaUsageRepairResponse): void {
	const counts = `indexed ${result.indexedSourceCount}, failed ${result.failedSourceCount}, skipped ${result.skippedSourceCount}, deleted ${result.deletedSourceCount}`;
	const scope =
		result.collections.length === 1 && result.collections[0]
			? `collection ${result.collections[0].collection}`
			: `${result.collections.length} collections`;

	if (result.status === "complete") {
		consola.success(`Media usage repair complete for ${scope} (${counts}).`);
		return;
	}

	const details = result.collections
		.filter((collection) => collection.status !== "complete")
		.map((collection) => {
			const error = collection.lastErrorCode ? `, ${collection.lastErrorCode}` : "";
			return `${collection.collection}: ${collection.status}${error}`;
		})
		.join("; ");
	const suffix = details ? ` ${details}.` : "";

	if (result.status === "stale") {
		consola.warn(
			`Media usage repair is stale for ${scope}; trustworthy complete coverage was not established. Rerun when writes are quiet (${counts}).${suffix}`,
		);
		return;
	}

	if (result.status === "partial") {
		consola.warn(
			`Media usage repair is partial for ${scope}; some sources or collections need attention (${counts}).${suffix}`,
		);
		return;
	}

	consola.warn(`Media usage repair failed for ${scope} (${counts}).${suffix}`);
}

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
		"repair-usage": repairUsageCommand,
	},
});
