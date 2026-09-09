import { env, exports as workerExports } from "cloudflare:workers";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { up } from "../../src/database/migrations/076_plugin_storage_revisions.js";
import type { Database } from "../../src/database/types.js";
import type {
	ConditionalDeleteResult,
	ConditionalWriteResult,
	VersionedValue,
} from "../../src/plugins/types.js";
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

// RPC promises are callable; assertion libraries must receive a native promise.
async function awaitRpc<T>(result: PromiseLike<T>): Promise<T> {
	return await result;
}

interface AtomicStore {
	getVersioned(key: string): Promise<VersionedValue | null>;
	compareAndSet(
		key: string,
		revision: string | null,
		value: unknown,
	): Promise<ConditionalWriteResult>;
	compareAndDelete(key: string, revision: string): Promise<ConditionalDeleteResult>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
}

function store(kind: "collection" | "kv", pluginId = "owner", collection = "records"): AtomicStore {
	const rpc = bridge(pluginId, [collection]);
	return kind === "kv"
		? {
				getVersioned: (key) => awaitRpc(rpc.kvGetVersioned(key)),
				compareAndSet: (key, revision, value) =>
					awaitRpc(rpc.kvCompareAndSet(key, revision, value)),
				compareAndDelete: (key, revision) => awaitRpc(rpc.kvCompareAndDelete(key, revision)),
				put: (key, value) => awaitRpc(rpc.kvSet(key, value)),
				delete: (key) => awaitRpc(rpc.kvDelete(key)),
			}
		: {
				getVersioned: (key) => awaitRpc(rpc.storageGetVersioned(collection, key)),
				compareAndSet: (key, revision, value) =>
					awaitRpc(rpc.storageCompareAndSet(collection, key, revision, value)),
				compareAndDelete: (key, revision) =>
					awaitRpc(rpc.storageCompareAndDelete(collection, key, revision)),
				put: (key, value) => awaitRpc(rpc.storagePut(collection, key, value)),
				delete: (key) => awaitRpc(rpc.storageDelete(collection, key)),
			};
}

async function current(target: AtomicStore, key = "key"): Promise<VersionedValue> {
	const value = await target.getVersioned(key);
	if (!value) throw new Error("Missing fixture value");
	return value;
}

describe("conditional plugin storage through Cloudflare RPC and D1", () => {
	it("legacy KV reads propagate database failures through RPC", async () => {
		const rpc = bridge();
		await rpc.kvSet("key", "stored");
		expect(await rpc.kvGet("key")).toBe("stored");
		await sql`DROP TABLE _plugin_storage`.execute(db);
		await expect(awaitRpc(rpc.kvGet("key"))).rejects.toThrow();
	});

	for (const kind of ["collection", "kv"] as const) {
		it(`${kind}: keeps absent keys distinct from stored JSON null across RPC`, async () => {
			const target = store(kind);
			expect(await target.getVersioned("key")).toBeNull();
			const inserted = await target.compareAndSet("key", null, null);
			if (!inserted.applied) throw new Error("Expected insertion");
			expect(await target.getVersioned("key")).toEqual({
				value: null,
				revision: inserted.revision,
			});
			expect(await target.compareAndSet("key", null, "overwrite")).toEqual({ applied: false });
			expect(await target.compareAndSet("missing", inserted.revision, "overwrite")).toEqual({
				applied: false,
			});
			expect(await target.compareAndDelete("missing", inserted.revision)).toEqual({
				applied: false,
			});
		});

		it(`${kind}: admits one concurrent creator, replacer and deleter`, async () => {
			const target = store(kind);
			const creates = await Promise.all(
				Array.from({ length: 6 }, (_, index) => target.compareAndSet("key", null, index)),
			);
			expect(creates.filter((result) => result.applied)).toHaveLength(1);
			const initial = await current(target);
			const updates = await Promise.all(
				Array.from({ length: 6 }, (_, index) =>
					target.compareAndSet("key", initial.revision, index + 10),
				),
			);
			expect(updates.filter((result) => result.applied)).toHaveLength(1);
			const updated = await current(target);
			expect(updates.find((result) => result.applied)).toEqual({
				applied: true,
				revision: updated.revision,
			});
			expect(updated.revision).not.toBe(initial.revision);
			const deletes = await Promise.all(
				Array.from({ length: 6 }, () => target.compareAndDelete("key", updated.revision)),
			);
			expect(deletes.filter((result) => result.applied)).toHaveLength(1);
			expect(await target.getVersioned("key")).toBeNull();
		});

		it(`${kind}: existing unconditional writes invalidate equal-value revisions`, async () => {
			const target = store(kind);
			await target.put("key", { state: "ready", revision: "caller-value" });
			const initial = await current(target);
			expect(initial.revision).not.toBe("caller-value");
			await target.put("key", initial.value);
			expect((await current(target)).revision).not.toBe(initial.revision);
			expect(await target.compareAndSet("key", initial.revision, "stale")).toEqual({
				applied: false,
			});
			expect(await target.compareAndDelete("key", initial.revision)).toEqual({ applied: false });
		});

		it(`${kind}: rejects stale tokens after deletion and recreation`, async () => {
			const target = store(kind);
			await target.put("key", "same");
			const initial = await current(target);
			await target.delete("key");
			await target.put("key", "same");
			expect((await current(target)).revision).not.toBe(initial.revision);
			expect(await target.compareAndSet("key", initial.revision, "stale")).toEqual({
				applied: false,
			});
			expect(await target.compareAndDelete("key", initial.revision)).toEqual({ applied: false });
			expect((await current(target)).value).toBe("same");
		});

		it(`${kind}: rejects omitted preconditions, invalid keys and missing values`, async () => {
			const target = store(kind);
			await target.put("key", "retained");
			for (const revision of [undefined, 0, {}, [], "", "x".repeat(129)]) {
				// @ts-expect-error -- RPC callers can omit or send malformed preconditions.
				await expect(target.compareAndSet("key", revision, "bad")).rejects.toThrow();
				// @ts-expect-error -- RPC callers can omit or send malformed preconditions.
				await expect(target.compareAndDelete("key", revision)).rejects.toThrow();
			}
			for (const key of [undefined, null, {}, "", "x".repeat(1025)]) {
				// @ts-expect-error -- RPC callers can send malformed keys.
				await expect(target.compareAndSet(key, null, "bad")).rejects.toThrow();
			}
			await expect(target.compareAndSet("missing", null, undefined)).rejects.toThrow();
			await expect(
				target.compareAndSet("missing", null, "x".repeat(1024 * 1024)),
			).rejects.toThrow();
			expect(await target.getVersioned("missing")).toBeNull();
			expect((await current(target)).value).toBe("retained");
		});

		it(`${kind}: scopes literal keys and revision tokens to the authenticated plugin`, async () => {
			const owner = store(kind);
			const other = store(kind, "other");
			for (const key of ["__proto__", "constructor", "toString", "x' OR 1=1 --"]) {
				await owner.put(key, "owner");
				await other.put(key, "other");
				const initial = await current(owner, key);
				expect(await other.compareAndSet(key, initial.revision, "overwrite")).toEqual({
					applied: false,
				});
				expect(await other.compareAndDelete(key, initial.revision)).toEqual({ applied: false });
				expect((await current(owner, key)).value).toBe("owner");
				expect((await current(other, key)).value).toBe("other");
			}
		});

		it(`${kind}: preserves secondary constraint errors for creation and replacement`, async () => {
			await sql`
				CREATE UNIQUE INDEX conditional_unique_value
				ON _plugin_storage (plugin_id, collection, data)
			`.execute(db);
			const target = store(kind);
			await target.put("first", "unique");
			await target.put("second", "other");
			const second = await current(target, "second");
			await expect(target.compareAndSet("third", null, "unique")).rejects.toThrow();
			await expect(target.compareAndSet("second", second.revision, "unique")).rejects.toThrow();
			expect(await target.getVersioned("third")).toBeNull();
			expect(await target.getVersioned("second")).toEqual(second);
		});
	}

	it("rejects direct RPC access to undeclared collections", async () => {
		const owner = store("collection", "owner", "hidden");
		await owner.put("key", "retained");
		const initial = await current(owner);
		const restricted = bridge();
		await expect(awaitRpc(restricted.storageGetVersioned("hidden", "key"))).rejects.toThrow();
		await expect(
			awaitRpc(restricted.storageCompareAndSet("hidden", "key", initial.revision, "bad")),
		).rejects.toThrow();
		await expect(
			awaitRpc(restricted.storageCompareAndSet("hidden", "fresh", null, "bad")),
		).rejects.toThrow();
		await expect(
			awaitRpc(restricted.storageCompareAndDelete("hidden", "key", initial.revision)),
		).rejects.toThrow();
		expect(await owner.getVersioned("key")).toEqual(initial);
		expect(await owner.getVersioned("fresh")).toBeNull();
	});

	it("keeps collection and KV namespaces separate for the same key", async () => {
		const records = store("collection");
		const settings = store("collection", "owner", "settings");
		const kv = store("kv");
		await records.put("key", "record");
		await settings.put("key", "setting");
		await kv.put("key", "value");
		const initial = await current(records);
		for (const target of [settings, kv]) {
			expect(await target.compareAndSet("key", initial.revision, "overwrite")).toEqual({
				applied: false,
			});
			expect(await target.compareAndDelete("key", initial.revision)).toEqual({ applied: false });
		}
		expect((await current(records)).value).toBe("record");
		expect((await current(settings)).value).toBe("setting");
		expect((await current(kv)).value).toBe("value");
	});

	it("existing bulk writes advance each affected revision through the bridge", async () => {
		const target = store("collection");
		await target.put("first", "same");
		await target.put("second", "same");
		const first = await current(target, "first");
		const second = await current(target, "second");
		await bridge().storagePutMany("records", [
			{ id: "first", data: "same" },
			{ id: "second", data: "same" },
		]);
		for (const [key, before] of [
			["first", first],
			["second", second],
		] as const) {
			expect((await current(target, key)).revision).not.toBe(before.revision);
			expect(await target.compareAndSet(key, before.revision, "stale")).toEqual({ applied: false });
		}
	});

	it("rejects operational database failures instead of reporting conflicts", async () => {
		await sql`DROP TABLE _plugin_storage`.execute(db);
		for (const kind of ["collection", "kv"] as const) {
			const target = store(kind);
			await expect(target.getVersioned("key")).rejects.toThrow();
			await expect(target.compareAndSet("key", null, "value")).rejects.toThrow();
			await expect(target.compareAndDelete("key", "revision")).rejects.toThrow();
		}
	});
});
