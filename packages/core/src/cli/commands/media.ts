/**
 * emdash media
 *
 * Manage media items via the EmDash API
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import type { MediaUsageRepairInput, MediaUsageRepairResponse } from "../../client/index.js";
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
		description:
			"Repair content media usage indexes. partial/stale exit 0; automation should use --json and parse status.",
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

		const hasCollectionArg = args.collection !== undefined;
		const hasCollection = typeof args.collection === "string";
		const hasAll = args.all === true;
		if ((hasCollectionArg && !hasCollection) || hasCollection === hasAll) {
			consola.error(repairScopeError);
			process.exit(1);
		}

		const client = createClientFromArgs(args);

		try {
			const repairInput: MediaUsageRepairInput = hasCollection
				? { scope: "collection", collection: args.collection }
				: { scope: "all" };
			const result = await client.mediaRepairUsage(repairInput);

			if (args.json || !process.stdout.isTTY) {
				output(result, args);
			} else {
				printRepairUsageSummary(result, repairInput);
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

type RepairUsageSummary = {
	level: "success" | "warn";
	message: string;
};

export function formatRepairUsageSummary(
	result: MediaUsageRepairResponse,
	input: MediaUsageRepairInput,
): RepairUsageSummary {
	const counts = `indexed ${result.indexedSourceCount}, failed ${result.failedSourceCount}, skipped ${result.skippedSourceCount}, deleted ${result.deletedSourceCount}`;
	const scope =
		input.scope === "collection"
			? `collection ${input.collection}`
			: `all content (${formatCollectionCount(result.collections.length)})`;

	if (result.status === "complete") {
		return {
			level: "success",
			message: `Media usage repair complete for ${scope} (${counts}).`,
		};
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
		return {
			level: "warn",
			message: `Media usage repair is stale for ${scope}; trustworthy complete coverage was not established because another writer, repair, or stale marker won the race. Rerun when writes are quiet (${counts}).${suffix}`,
		};
	}

	if (result.status === "partial") {
		return {
			level: "warn",
			message: `Media usage repair is partial for ${scope}; some sources or collections need attention (${counts}).${suffix}`,
		};
	}

	return {
		level: "warn",
		message: `Media usage repair failed for ${scope} (${counts}).${suffix}`,
	};
}

function printRepairUsageSummary(
	result: MediaUsageRepairResponse,
	input: MediaUsageRepairInput,
): void {
	const summary = formatRepairUsageSummary(result, input);
	if (summary.level === "success") {
		consola.success(summary.message);
	} else {
		consola.warn(summary.message);
	}
}

function formatCollectionCount(count: number): string {
	return `${count} collection${count === 1 ? "" : "s"}`;
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
