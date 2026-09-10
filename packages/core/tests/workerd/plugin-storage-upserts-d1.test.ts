import { env, exports as workerExports } from "cloudflare:workers";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { up } from "../../src/database/migrations/004_plugins.js";
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

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await up(db);
});

afterAll(async () => {
	await db.destroy();
});

function bridge(pluginId = "owner") {
	return workerExports.PluginBridge({
		props: {
			pluginId,
			pluginVersion: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: ["records", "settings"],
		},
	});
}

type WriteMethod = "kvSet" | "storagePut" | "storagePutMany";

async function put(method: WriteMethod, id: string, data: unknown): Promise<void> {
	const rpc = bridge();
	if (method === "kvSet") {
		await rpc.kvSet(id, data);
	} else if (method === "storagePut") {
		await rpc.storagePut("records", id, data);
	} else {
		await rpc.storagePutMany("records", [{ id, data }]);
	}
}

interface StorageRow {
	plugin_id: string;
	collection: string;
	id: string;
	data: string;
	created_at: string;
	updated_at: string;
}

async function rows(): Promise<StorageRow[]> {
	const result = await sql<StorageRow>`
		SELECT plugin_id, collection, id, data, created_at, updated_at
		FROM _plugin_storage
		ORDER BY plugin_id, collection, id
	`.execute(db);
	return result.rows;
}

async function addUniqueValueIndex(): Promise<void> {
	await sql`
		CREATE UNIQUE INDEX unique_plugin_storage_value
		ON _plugin_storage (plugin_id, collection, data)
	`.execute(db);
}

describe("plugin storage upserts through Cloudflare RPC and D1", () => {
	for (const method of ["kvSet", "storagePut", "storagePutMany"] as const) {
		it(`${method} preserves created_at when overwriting a row`, async () => {
			await put(method, "record", { value: "initial" });
			await sql`
				UPDATE _plugin_storage
				SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-02 00:00:00'
			`.execute(db);
			const [before] = await rows();

			await put(method, "record", { value: "updated" });

			expect(await rows()).toEqual([
				{
					...before,
					data: JSON.stringify({ value: "updated" }),
					created_at: "2020-01-01 00:00:00",
					updated_at: expect.any(String),
				},
			]);
			expect((await rows())[0]?.updated_at).not.toBe(before?.updated_at);
		});

		it(`${method} rejects unique collisions and preserves existing rows`, async () => {
			await addUniqueValueIndex();
			await put(method, "first", "unique");
			await put(method, "second", "other");
			const before = await rows();

			for (const id of ["third", "second"]) {
				await expect(put(method, id, "unique")).rejects.toThrow();
				expect(await rows()).toEqual(before);
			}
		});
	}

	it("storagePutMany inserts and overwrites items in order", async () => {
		const rpc = bridge();
		await rpc.storagePut("records", "existing", "initial");
		await sql`UPDATE _plugin_storage SET created_at = '2020-01-01 00:00:00'`.execute(db);

		await rpc.storagePutMany("records", [
			{ id: "existing", data: "updated" },
			{ id: "fresh", data: "first" },
			{ id: "fresh", data: "last" },
		]);

		expect(await rpc.storageGet("records", "existing")).toBe("updated");
		expect(await rpc.storageGet("records", "fresh")).toBe("last");
		expect(await rows()).toEqual([
			expect.objectContaining({ id: "existing", created_at: "2020-01-01 00:00:00" }),
			expect.objectContaining({ id: "fresh" }),
		]);
	});

	it("storagePutMany stops on a unique collision and keeps completed writes", async () => {
		const rpc = bridge();
		await addUniqueValueIndex();
		await rpc.storagePut("records", "existing", "initial");
		await rpc.storagePut("records", "reserved", "unique");
		const before = await rows();

		async function putMany(): Promise<void> {
			await rpc.storagePutMany("records", [
				{ id: "existing", data: "updated" },
				{ id: "collision", data: "unique" },
				{ id: "later", data: "unreached" },
			]);
		}
		await expect(putMany()).rejects.toThrow();

		expect(await rows()).toEqual([
			{ ...before[0], data: JSON.stringify("updated"), updated_at: expect.any(String) },
			before[1],
		]);
	});

	it("writes only the matching plugin, collection, and key", async () => {
		const owner = bridge();
		const other = bridge("other");
		await owner.kvSet("record", "kv");
		await owner.storagePut("records", "record", "record");
		await owner.storagePut("settings", "record", "setting");
		await other.storagePut("records", "record", "other plugin");

		await owner.storagePutMany("records", [{ id: "record", data: "updated record" }]);
		await owner.kvSet("record", "updated kv");

		expect(await owner.kvGet("record")).toBe("updated kv");
		expect(await owner.storageGet("records", "record")).toBe("updated record");
		expect(await owner.storageGet("settings", "record")).toBe("setting");
		expect(await other.storageGet("records", "record")).toBe("other plugin");
	});
});
