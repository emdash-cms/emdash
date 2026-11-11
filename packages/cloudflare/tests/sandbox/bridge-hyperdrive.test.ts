import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const { workerEnv, pending } = vi.hoisted(() => ({
	workerEnv: {} as Record<string, unknown>,
	pending: [] as Promise<unknown>[],
}));
vi.mock("cloudflare:workers", () => ({
	env: workerEnv,
	waitUntil: (promise: Promise<unknown>) => {
		pending.push(promise);
	},
	WorkerEntrypoint: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));

vi.mock("virtual:emdash/dialect", async () => import("../../src/db/hyperdrive.js"));

import { withBridgeDb } from "../../src/sandbox/bridge-db.js";
import { PluginBridge } from "../../src/sandbox/bridge.js";
import { BRIDGE_TEST_SCHEMA } from "./bridge-test-schema.js";

const descriptor = {
	entrypoint: "@emdash-cms/cloudflare/db/hyperdrive",
	type: "postgres" as const,
	config: { binding: "PRIMARY", cachedBinding: "CACHED" },
};

afterEach(async () => {
	await Promise.all(pending.splice(0));
	for (const key of Object.keys(workerEnv)) delete workerEnv[key];
	vi.restoreAllMocks();
});

describe("PluginBridge Hyperdrive connection lifecycle", () => {
	it("does not share pools between concurrent RPC failures", async () => {
		workerEnv.PRIMARY = { connectionString: "postgres://127.0.0.1:1/site" };
		const end = vi.spyOn(Pool.prototype, "end");
		const results = await Promise.allSettled(
			[1, 2].map(() =>
				withBridgeDb(descriptor, (db) => db.selectFrom("users").selectAll().execute()),
			),
		);
		await Promise.all(pending.splice(0));
		expect(results.every((result) => result.status === "rejected")).toBe(true);
		expect(end).toHaveBeenCalledTimes(2);
		expect(end.mock.instances[0]).not.toBe(end.mock.instances[1]);
	});

	it("closes each failed bridge RPC's real pg pool without using the cached or D1 binding", async () => {
		// A refused loopback port exercises the real pg failure path without an external server.
		workerEnv.PRIMARY = { connectionString: "postgres://127.0.0.1:1/site" };
		workerEnv.CACHED = { connectionString: "not a connection string" };
		const end = vi.spyOn(Pool.prototype, "end");
		const bridge = new PluginBridge(
			{
				props: {
					pluginId: "test",
					pluginVersion: "1",
					capabilities: [],
					allowedHosts: [],
					storageCollections: ["items"],
					database: descriptor,
				},
			} as never,
			{} as never,
		);
		for (let i = 0; i < 2; i++) {
			await expect(bridge.storageGet("items", "one")).rejects.toMatchObject({
				code: "ECONNREFUSED",
			});
		}
		await Promise.all(pending.splice(0));
		expect(end).toHaveBeenCalledTimes(2);
		expect(end.mock.instances[0]).not.toBe(end.mock.instances[1]);
	});

	it("fails closed when the configured binding is missing", async () => {
		const operation = vi.fn();
		await expect(withBridgeDb(descriptor, operation)).rejects.toThrow(/PRIMARY.*not found/);
		expect(operation).not.toHaveBeenCalled();
	});
});

describe.skipIf(!process.env.EMDASH_TEST_PG)("PluginBridge Hyperdrive PostgreSQL", () => {
	it("shares host storage, content, and media across bridge events", async () => {
		const schema = `bridge_${randomUUID().replaceAll("-", "")}`;
		const url = new URL(process.env.EMDASH_TEST_PG!);
		const admin = new Pool({ connectionString: url.toString() });
		await admin.query(`CREATE SCHEMA "${schema}"`);
		url.searchParams.set("options", `-c search_path=${schema}`);
		const host = new Pool({ connectionString: url.toString() });
		workerEnv.PRIMARY = { connectionString: url.toString() };
		workerEnv.CACHED = { connectionString: "postgres://127.0.0.1:1/wrong" };
		try {
			await host.query(BRIDGE_TEST_SCHEMA);
			const bridge = new PluginBridge(
				{
					props: {
						pluginId: "test",
						pluginVersion: "1",
						allowedHosts: [],
						storageCollections: ["items"],
						capabilities: [
							"content:read",
							"content:write",
							"media:read",
							"media:write",
							"media:metadata:write",
						],
						database: descriptor,
					},
				} as never,
				{} as never,
			);
			await bridge.storagePut("items", "one", { title: "shared" });
			expect(await bridge.storageGet("items", "one")).toEqual({ title: "shared" });
			expect(
				JSON.parse(
					(await host.query("SELECT data FROM _plugin_storage WHERE id = 'one'")).rows[0].data,
				),
			).toEqual({ title: "shared" });
			const version = await bridge.storageGetVersioned("items", "one");
			expect(
				(await bridge.storageCompareAndSet("items", "one", version!.revision, { title: "updated" }))
					.applied,
			).toBe(true);
			await bridge.settingsSet("timezone", "UTC");
			expect(await bridge.settingsGet("timezone")).toBe("UTC");
			const content = await bridge.contentCreate("posts", { title: "A post", slug: "a-post" });
			if ("__emdashContentCreateError" in content) throw new Error(content.error.message);
			expect(await bridge.contentGet("posts", content.id)).toMatchObject({
				data: { title: "A post" },
			});
			expect(
				(await host.query("SELECT title FROM ec_posts WHERE id = $1", [content.id])).rows[0].title,
			).toBe("A post");
			expect(await bridge.contentDelete("posts", content.id)).toBe(true);
			await host.query(
				"INSERT INTO media (id, filename, mime_type, size, storage_key, status, created_at) VALUES ('image', 'test.png', 'image/png', 10, 'test.png', 'ready', $1)",
				[new Date().toISOString()],
			);
			expect(await bridge.mediaGet("image")).toMatchObject({ id: "image" });
			await bridge.mediaUpdateMetadata("image", { alt: "A test image" });
			expect((await host.query("SELECT alt FROM media WHERE id = 'image'")).rows[0].alt).toBe(
				"A test image",
			);
			expect(await bridge.mediaDelete("image")).toBe(true);
		} finally {
			await Promise.all(pending.splice(0));
			await host.end();
			await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
			await admin.end();
		}
	});
});
