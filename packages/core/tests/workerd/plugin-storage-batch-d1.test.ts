import { env, exports as workerExports } from "cloudflare:workers";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { up } from "../../src/database/migrations/077_plugin_storage_revisions.js";
import { PluginStorageRepository } from "../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../src/database/types.js";
import { createLegacyPluginStorageTables } from "../utils/plugin-storage-revision-cases.js";
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

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await createLegacyPluginStorageTables(db);
	await up(db);
});

afterAll(async () => {
	await db.destroy();
});

// More ids than fit alongside plugin_id and collection in one statement under
// D1's 100 bound-parameter limit.
const ID_COUNT = 150;

function makeItems(): Array<{ id: string; data: { index: number } }> {
	return Array.from({ length: ID_COUNT }, (_, i) => ({
		id: `record-${i.toString().padStart(4, "0")}`,
		data: { index: i },
	}));
}

function repo(pluginId: string, collection: string) {
	return new PluginStorageRepository<{ index: number }>(db, pluginId, collection, []);
}

function bridge() {
	return workerExports.PluginBridge({
		props: {
			pluginId: "owner",
			pluginVersion: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: ["records"],
		},
	});
}

// RPC promises are callable; assertion libraries must receive a native promise.
async function awaitRpc<T>(result: PromiseLike<T>): Promise<T> {
	return await result;
}

describe("PluginStorageRepository batch operations on D1", () => {
	it("getMany and deleteMany accept more ids than D1's single-statement bind limit", async () => {
		const target = repo("batch-test-plugin", "records");
		const items = makeItems();
		await target.putMany(items);

		const ids = items.map((item) => item.id);
		const fetched = await target.getMany(ids);

		expect(fetched.size).toBe(ID_COUNT);
		for (const item of items) {
			expect(fetched.get(item.id)).toEqual(item.data);
		}

		expect(await target.deleteMany(ids)).toBe(ID_COUNT);
		expect((await target.getMany(ids)).size).toBe(0);
	});
});

describe("sandboxed plugin batch storage through Cloudflare RPC and D1", () => {
	it("storageGetMany and storageDeleteMany accept more ids than D1's single-statement bind limit", async () => {
		const items = makeItems();
		const ids = items.map((item) => item.id);
		const rpc = bridge();
		await rpc.storagePutMany("records", items);

		const fetched = await rpc.storageGetMany("records", ids);

		expect(fetched.size).toBe(ID_COUNT);
		for (const item of items) {
			expect(fetched.get(item.id)).toEqual(item.data);
		}

		expect(await rpc.storageDeleteMany("records", ids)).toBe(ID_COUNT);
		expect((await rpc.storageGetMany("records", ids)).size).toBe(0);
	});

	it("storageGetMany and storageDeleteMany only touch the calling plugin's collection", async () => {
		const items = makeItems();
		const ids = items.map((item) => item.id);
		const otherPlugin = repo("other", "records");
		const otherCollection = repo("owner", "settings");
		await otherPlugin.putMany(items.map((item) => ({ ...item, data: { index: -1 } })));
		await otherCollection.putMany(items.map((item) => ({ ...item, data: { index: -2 } })));
		const owned = items.slice(0, 10);
		const rpc = bridge();
		await rpc.storagePutMany("records", owned);

		const fetched = await rpc.storageGetMany("records", ids);

		expect(new Map(fetched)).toEqual(new Map(owned.map((item) => [item.id, item.data])));
		expect(await rpc.storageDeleteMany("records", ids)).toBe(owned.length);
		expect((await otherPlugin.getMany(ids)).size).toBe(ID_COUNT);
		expect((await otherCollection.getMany(ids)).size).toBe(ID_COUNT);
	});

	it("storageGetMany and storageDeleteMany reject undeclared collections", async () => {
		const rpc = bridge();
		await repo("owner", "settings").put("a", { index: 0 });

		await expect(awaitRpc(rpc.storageGetMany("settings", ["a"]))).rejects.toThrow(
			"Storage collection not declared: settings",
		);
		await expect(awaitRpc(rpc.storageDeleteMany("settings", ["a"]))).rejects.toThrow(
			"Storage collection not declared: settings",
		);
		expect(await repo("owner", "settings").get("a")).toEqual({ index: 0 });
	});
});
