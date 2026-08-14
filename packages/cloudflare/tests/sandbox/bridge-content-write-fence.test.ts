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

const bridgeContext = {
	props: {
		pluginId: "test-plugin",
		pluginVersion: "1.0.0",
		capabilities: ["content:write"],
		allowedHosts: [],
		storageCollections: [],
	},
};

function makeBridge(db: unknown) {
	return new PluginBridge(bridgeContext as never, { DB: db } as never);
}

describe("PluginBridge content write fence", () => {
	it("rejects content mutations while media usage activation is incomplete", async () => {
		const queries: string[] = [];
		const db = {
			prepare(sql: string) {
				queries.push(sql);
				return {
					bind() {
						return this;
					},
					async first() {
						return { state: "activating" };
					},
					async run() {
						return { meta: { changes: 1 } };
					},
				};
			},
		};
		const bridge = makeBridge(db);

		await expect(bridge.contentCreate("posts", { slug: "blocked" })).rejects.toMatchObject({
			code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
			message: "Media usage activation is in progress",
			status: 503,
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("_emdash_media_usage_activation");
	});

	it("preserves content writes before the activation table is migrated", async () => {
		const queries: string[] = [];
		const db = {
			prepare(sql: string) {
				queries.push(sql);
				const statement = {
					bind() {
						return statement;
					},
					async first() {
						if (sql.includes("_emdash_media_usage_activation")) {
							throw new Error("D1_ERROR: no such table: _emdash_media_usage_activation");
						}
						return {
							id: "created-id",
							created_at: "2026-08-09T00:00:00.000Z",
							updated_at: "2026-08-09T00:00:00.000Z",
						};
					},
					async run() {
						return { meta: { changes: 1 } };
					},
				};
				return statement;
			},
		};

		await expect(makeBridge(db).contentCreate("posts", { slug: "created" })).resolves.toEqual(
			expect.objectContaining({ id: "created-id", type: "posts" }),
		);
		expect(queries).toHaveLength(3);
	});

	it("fails closed without exposing unexpected database errors", async () => {
		const db = {
			prepare() {
				return {
					bind() {
						return this;
					},
					async first() {
						throw new Error("private database failure");
					},
				};
			},
		};
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(
				makeBridge(db).contentCreate("posts", { slug: "blocked" }),
			).rejects.toMatchObject({
				code: "MEDIA_USAGE_ACTIVATION_CHECK_FAILED",
				message: "Unable to verify media usage activation state",
				status: 503,
			});
		} finally {
			consoleError.mockRestore();
		}
	});
});
