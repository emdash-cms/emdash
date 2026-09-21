import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { PluginBridge } from "../../src/sandbox/bridge.js";

function makeBridge(capabilities: string[], db: unknown = {}) {
	return new PluginBridge(
		{
			props: {
				pluginId: "media-test",
				pluginVersion: "1.0.0",
				capabilities,
				allowedHosts: [],
				storageCollections: [],
			},
		} as never,
		{ DB: db } as never,
	);
}

describe("PluginBridge media capability separation", () => {
	it("does not grant byte or metadata mutation authority with media:read", async () => {
		const bridge = makeBridge(["media:read"]);
		await expect(bridge.mediaReadBytes("media-1")).rejects.toThrow(
			"Missing capability: media:bytes:read",
		);
		await expect(bridge.mediaUpdateMetadata("media-1", { alt: "Changed" })).rejects.toThrow(
			"Missing capability: media:metadata:write",
		);
	});

	it("does not grant metadata reads with media:bytes:read", async () => {
		const bridge = makeBridge(["media:bytes:read"]);
		await expect(bridge.mediaGet("media-1")).rejects.toThrow("Missing capability: media:read");
		await expect(bridge.mediaList()).rejects.toThrow("Missing capability: media:read");
	});

	it("matches workerd validation for a non-number byte limit", async () => {
		const bridge = makeBridge(["media:bytes:read"]);
		await expect(bridge.mediaReadBytes("media-1", "ten" as never)).rejects.toThrow(
			new TypeError("media/readBytes: maxBytes must be a number"),
		);
	});

	it.each([
		{ limit: -2, expectedItems: 1, expectedSqlLimit: 2 },
		{ limit: "bad", expectedItems: 4, expectedSqlLimit: 51 },
	])(
		"normalizes a $limit media list limit before querying D1",
		async ({ limit, expectedItems, expectedSqlLimit }) => {
			const queries: Array<{ sql: string; params: unknown[] }> = [];
			const rows = ["one", "two", "three", "four"].map((id) => ({
				id,
				filename: `${id}.png`,
				mime_type: "image/png",
				size: 1,
				width: null,
				height: null,
				focal_x: null,
				focal_y: null,
				alt: null,
				caption: null,
				storage_key: `media/${id}`,
				status: "ready",
				content_hash: null,
				blurhash: null,
				dominant_color: null,
				created_at: "2026-09-19T00:00:00.000Z",
				author_id: null,
				folder_id: null,
			}));
			const db = {
				prepare(sql: string) {
					const statement = {
						params: [] as unknown[],
						bind(...params: unknown[]) {
							statement.params = params;
							return statement;
						},
						async all() {
							queries.push({ sql, params: statement.params });
							return { results: rows, meta: { changes: 0 } };
						},
					};
					return statement;
				},
			};

			const result = await makeBridge(["media:read"], db).mediaList({ limit: limit as never });

			expect(result.items).toHaveLength(expectedItems);
			expect(queries).toHaveLength(1);
			expect(queries[0]?.params).toContain(expectedSqlLimit);
		},
	);
});
