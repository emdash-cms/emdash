import { env, exports as workerExports } from "cloudflare:workers";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
		interface GlobalProps {
			mainModule: typeof import("./fixtures/plugin-storage-worker.js");
		}
	}
}

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await db.schema
		.createTable("_plugin_storage")
		.addColumn("plugin_id", "text", (column) => column.notNull())
		.addColumn("collection", "text", (column) => column.notNull())
		.addColumn("id", "text", (column) => column.notNull())
		.addColumn("data", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo("2026-01-01"))
		.addColumn("updated_at", "text", (column) => column.notNull())
		.addPrimaryKeyConstraint("pk_plugin_storage", ["plugin_id", "collection", "id"])
		.execute();
});

beforeEach(async () => {
	await db.deleteFrom("_plugin_storage").execute();
});

afterAll(async () => {
	await db.destroy();
});

function bridge(pluginId = "owner", storageCollections = ["records"]) {
	return workerExports.PluginBridge({
		props: {
			pluginId,
			pluginVersion: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections,
		},
	});
}

async function awaitRpc<T>(result: PromiseLike<T>): Promise<T> {
	return await result;
}

describe("guarded plugin storage through Cloudflare RPC and D1", () => {
	it("applies only the available guarded decrements", async () => {
		const rpc = bridge();
		await rpc.storagePut("records", "stock", { stock: 2, title: "retained" });
		const outcomes = await Promise.all(
			Array.from({ length: 4 }, () =>
				awaitRpc(
					rpc.storageUpdateIf("records", "stock", {
						where: { stock: { gte: 1 } },
						delta: { stock: { dec: 1 } },
					}),
				),
			),
		);
		expect(outcomes.filter((result) => "applied" in result && result.applied)).toHaveLength(2);
		expect(outcomes.filter((result) => "applied" in result && !result.applied)).toHaveLength(2);
		expect(await rpc.storageGet("records", "stock")).toEqual({ stock: 0, title: "retained" });
	});

	it("keeps plugin, collection and literal key boundaries", async () => {
		const owner = bridge("owner", ["records", "other"]);
		const other = bridge("other");
		for (const [rpc, collection] of [
			[owner, "records"],
			[owner, "other"],
			[other, "records"],
		] as const) {
			await rpc.storagePut(collection, "constructor", { state: "ready" });
		}
		expect(
			await owner.storageUpdateIf("records", "constructor", {
				where: { state: "ready" },
				set: { state: "running" },
			}),
		).toEqual({ applied: true, data: { state: "running" } });
		expect(await owner.storageGet("other", "constructor")).toEqual({ state: "ready" });
		expect(await other.storageGet("records", "constructor")).toEqual({ state: "ready" });
		await expect(
			awaitRpc(
				bridge("owner", []).storageUpdateIf("records", "constructor", {
					where: {},
					set: { state: "changed" },
				}),
			),
		).rejects.toThrow("Storage collection not declared");
	});

	it("rejects malformed guards without changing the stored document", async () => {
		const rpc = bridge();
		await rpc.storagePut("records", "stock", { stock: 2 });
		for (const where of [[], { stock: { gte: undefined } }]) {
			await expect(
				awaitRpc(
					rpc.storageUpdateIf("records", "stock", {
						where,
						set: { stock: 100 },
					}),
				),
			).rejects.toThrow();
		}
		expect(await rpc.storageGet("records", "stock")).toEqual({ stock: 2 });
	});

	it.each(["2", true, 1.5, Number.MAX_SAFE_INTEGER])(
		"does not overwrite invalid or overflowing counters: %s",
		async (stock) => {
			const rpc = bridge();
			await rpc.storagePut("records", "stock", { stock, state: "ready" });
			expect(
				await rpc.storageUpdateIf("records", "stock", {
					where: {},
					set: { state: "changed" },
					delta: { stock: { inc: 1 } },
				}),
			).toEqual({ applied: false });
			expect(await rpc.storageGet("records", "stock")).toEqual({ stock, state: "ready" });
		},
	);

	it("does not create a missing row", async () => {
		const rpc = bridge();
		expect(
			await rpc.storageUpdateIf("records", "missing", {
				where: {},
				set: { state: "ready" },
			}),
		).toEqual({ applied: false });
		expect(await rpc.storageGet("records", "missing")).toBeNull();
	});
});
