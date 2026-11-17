import { readFileSync } from "node:fs";

import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { parse } from "jsonc-parser";
import { describe, expect, it, vi } from "vitest";

import plugin from "../src/plugin.js";

const manifest = parse(
	readFileSync(new URL("../emdash-plugin.jsonc", import.meta.url), "utf8"),
) as {
	admin: { pages: { path: string }[]; widgets: { id: string }[] };
};
const policy = {
	pluginPagePaths: manifest.admin.pages.map((page) => page.path),
	allowedImageHosts: [],
};

type QueryOptions = { cursor?: string };
type AuditItem = {
	id: string;
	data: {
		timestamp: string;
		action: "create" | "update" | "delete";
		resourceId: string;
		resourceType: "content";
		collection?: string;
	};
};

const firstEntry: AuditItem = {
	id: "entry-1",
	data: {
		timestamp: "2026-01-02T00:00:00.000Z",
		action: "create",
		resourceId: "post-1",
		resourceType: "content",
		collection: "posts",
	},
};
const secondEntry: AuditItem = {
	id: "entry-2",
	data: {
		timestamp: "2026-01-01T00:00:00.000Z",
		action: "update",
		resourceId: "post-2",
		resourceType: "content",
		collection: "posts",
	},
};

function createCtx(
	query: (options: QueryOptions) => Promise<{
		items: AuditItem[];
		cursor?: string;
		hasMore?: boolean;
	}> = async () => ({ items: [] }),
) {
	return {
		storage: { entries: { query: vi.fn(query) } },
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
}

async function admin(input: unknown, ctx = createCtx()) {
	// eslint-disable-next-line typescript/no-explicit-any -- exercising the route handler directly
	return (plugin.routes.admin.handler as any)({ input }, ctx);
}

function expectValid(response: { blocks: unknown[] }) {
	expect(validateBlockResponse(response, policy)).toEqual({ valid: true, errors: [] });
}

describe("audit-log admin responses", () => {
	it("returns a valid empty history table with its empty state", async () => {
		const response = await admin({ type: "page_load", page: "/history" });
		expectValid(response);

		const table = response.blocks[3] as Record<string, unknown>;
		expect(table).toMatchObject({
			type: "table",
			page_action_id: "load-page",
			empty_text: "No audit entries yet",
		});
		expect(table.rows).toEqual([]);
	});

	it("returns a valid populated history table and its cursor", async () => {
		const ctx = createCtx(async () => ({ items: [firstEntry], cursor: "cursor-2", hasMore: true }));
		const response = await admin({ type: "page_load", page: "/history" }, ctx);
		expectValid(response);

		const table = response.blocks[3] as Record<string, unknown>;
		expect(table).toMatchObject({
			block_id: "history-table",
			page_action_id: "load-page",
			next_cursor: "cursor-2",
		});
		expect(table.rows).toEqual([
			{
				action: "create",
				resource: "post-1",
				collection: "posts",
				time: firstEntry.data.timestamp,
			},
		]);
	});

	it("uses the cursor from a table action to load the next page", async () => {
		const query = vi.fn(async ({ cursor }: QueryOptions) =>
			cursor === "cursor-2"
				? { items: [secondEntry], cursor: undefined, hasMore: false }
				: { items: [firstEntry], cursor: "cursor-2", hasMore: true },
		);
		const ctx = createCtx(query);
		const firstPage = await admin({ type: "page_load", page: "/history" }, ctx);
		expectValid(firstPage);
		const table = firstPage.blocks[3] as Record<string, unknown>;
		const response = await admin(
			{
				type: "block_action",
				action_id: table.page_action_id,
				block_id: table.block_id,
				value: { cursor: table.next_cursor, sort: null },
			},
			ctx,
		);
		expectValid(response);
		expect((response.blocks[3] as Record<string, unknown>).next_cursor).toBeUndefined();
		expect((response.blocks[3] as Record<string, unknown>).rows).toEqual([
			{
				action: "update",
				resource: "post-2",
				collection: "posts",
				time: secondEntry.data.timestamp,
			},
		]);
	});

	it.each([
		["populated", [firstEntry], { type: "fields" }],
		["empty", [], { type: "context", text: "No recent activity" }],
	])("returns a valid %s recent-activity widget", async (_name, items, expected) => {
		const response = await admin(
			{ type: "page_load", page: "widget:recent-activity" },
			createCtx(async () => ({ items })),
		);
		expectValid(response);
		expect(response.blocks[0]).toMatchObject(expected);
	});

	it("returns valid empty blocks for unknown interactions", async () => {
		const response = await admin({ type: "unknown" });
		expect(response).toEqual({ blocks: [] });
		expectValid(response);
	});

	it.each([
		["history", { type: "page_load", page: "/history" }],
		["widget", { type: "page_load", page: "widget:recent-activity" }],
	])("returns a valid error response when %s storage fails", async (_name, input) => {
		const ctx = createCtx(async () => {
			throw new Error("storage unavailable");
		});
		const response = await admin(input, ctx);
		expectValid(response);
		expect(response.blocks[0]).toMatchObject({ type: "context" });
	});
});
