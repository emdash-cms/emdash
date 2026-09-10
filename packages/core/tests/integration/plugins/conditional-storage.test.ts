import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { up as migrateRevisions } from "../../../src/database/migrations/076_plugin_storage_revisions.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import { createKVAccess, createStorageAccess } from "../../../src/plugins/context.js";
import type {
	ConditionalDeleteResult,
	ConditionalWriteResult,
	VersionedValue,
} from "../../../src/plugins/types.js";
import { createLegacyPluginStorageTables } from "../../utils/plugin-storage-revision-cases.js";
import {
	createForDialect,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface Store {
	getVersioned(key: string): Promise<VersionedValue | null>;
	compareAndSet(
		key: string,
		revision: string | null,
		value: unknown,
	): Promise<ConditionalWriteResult>;
	compareAndDelete(key: string, revision: string): Promise<ConditionalDeleteResult>;
	put(key: string, value: unknown): Promise<void>;
	putMany(items: Array<{ id: string; data: unknown }>): Promise<void>;
	delete(key: string): Promise<boolean>;
}

describeEachDialect("conditional plugin storage", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function store(kind: "collection" | "kv", pluginId = "owner", collection = "jobs"): Store {
		if (kind === "collection") {
			return createStorageAccess(db, pluginId, { [collection]: { indexes: [] } })[collection];
		}
		const options = new OptionsRepository(db);
		const kv = createKVAccess(options, pluginId);
		return {
			...kv,
			put: (key, value) => kv.set(key, value),
			putMany: (items) =>
				options.setMany(
					Object.fromEntries(items.map(({ id, data }) => [`plugin:${pluginId}:${id}`, data])),
				),
		};
	}

	for (const kind of ["collection", "kv"] as const) {
		it(`${kind}: distinguishes an absent key from stored JSON null`, async () => {
			const target = store(kind);
			expect(await target.getVersioned("key")).toBeNull();
			expect(await target.compareAndSet("key", "missing-revision", "value")).toEqual({
				applied: false,
			});
			expect(await target.compareAndDelete("key", "missing-revision")).toEqual({ applied: false });
			const result = await target.compareAndSet("key", null, null);
			expect(result.applied).toBe(true);
			if (!result.applied) throw new Error("Expected insertion");
			expect(await target.getVersioned("key")).toEqual({ value: null, revision: result.revision });
			expect(await target.compareAndSet("key", null, "overwrite")).toEqual({ applied: false });
		});

		it(`${kind}: admits one concurrent creator and one replacement for a revision`, async () => {
			const target = store(kind);
			const creates = await Promise.all(
				Array.from({ length: 8 }, (_, value) => target.compareAndSet("key", null, value)),
			);
			expect(creates.filter((result) => result.applied)).toHaveLength(1);
			const first = await target.getVersioned("key");
			if (!first) throw new Error("Missing inserted value");
			const writes = await Promise.all(
				Array.from({ length: 8 }, (_, value) =>
					target.compareAndSet("key", first.revision, value + 10),
				),
			);
			const winner = writes.find((result) => result.applied);
			expect(writes.filter((result) => result.applied)).toHaveLength(1);
			expect(winner?.applied && winner.revision).toBe((await target.getVersioned("key"))?.revision);
			expect((await target.getVersioned("key"))?.revision).not.toBe(first.revision);
		});

		it(`${kind}: rejects stale deletion after an intervening write`, async () => {
			const target = store(kind);
			await target.put("key", "initial");
			const first = await target.getVersioned("key");
			if (!first) throw new Error("Missing value");
			await target.put("key", "newer");
			expect(await target.compareAndDelete("key", first.revision)).toEqual({ applied: false });
			const current = await target.getVersioned("key");
			if (!current) throw new Error("Missing current value");
			const results = await Promise.all([
				target.compareAndDelete("key", current.revision),
				target.compareAndDelete("key", current.revision),
			]);
			expect(results.filter((result) => result.applied)).toHaveLength(1);
			expect(await target.getVersioned("key")).toBeNull();
		});

		it(`${kind}: invalidates tokens after equal-value single and batch writes`, async () => {
			const target = store(kind);
			await target.put("key", { revision: "untrusted", value: 1 });
			for (const write of [
				() => target.put("key", { revision: "untrusted", value: 1 }),
				() => target.putMany([{ id: "key", data: { revision: "untrusted", value: 1 } }]),
			]) {
				const old = await target.getVersioned("key");
				if (!old) throw new Error("Missing value");
				expect(old.revision).not.toBe("untrusted");
				await write();
				expect(await target.compareAndSet("key", old.revision, "stale")).toEqual({
					applied: false,
				});
			}
		});

		it(`${kind}: never revives a token after delete and recreation`, async () => {
			const target = store(kind);
			await target.put("key", "same");
			const old = await target.getVersioned("key");
			if (!old) throw new Error("Missing value");
			await target.delete("key");
			await target.put("key", "same");
			expect(await target.compareAndSet("key", old.revision, "stale")).toEqual({ applied: false });
			expect(await target.compareAndDelete("key", old.revision)).toEqual({ applied: false });
			expect((await target.getVersioned("key"))?.value).toBe("same");
		});

		it(`${kind}: keeps tokens and SQL-like keys scoped to the owning plugin`, async () => {
			const owner = store(kind);
			const other = store(kind, "other");
			for (const key of ["__proto__", "constructor", "toString", "x' OR 1=1 --"]) {
				await owner.put(key, "owner");
				await other.put(key, "other");
				const record = await owner.getVersioned(key);
				if (!record) throw new Error("Missing owner value");
				expect(await other.compareAndSet(key, record.revision, "overwrite")).toEqual({
					applied: false,
				});
				expect(await other.compareAndDelete(key, record.revision)).toEqual({ applied: false });
				expect((await owner.getVersioned(key))?.value).toBe("owner");
				expect((await other.getVersioned(key))?.value).toBe("other");
			}
		});

		it(`${kind}: rejects malformed preconditions before changing stored data`, async () => {
			const target = store(kind);
			await target.put("key", "retained");
			for (const revision of [undefined, 0, {}, [], "", "x".repeat(129)]) {
				// @ts-expect-error -- untyped bridge callers can send invalid preconditions.
				await expect(target.compareAndSet("key", revision, "bad")).rejects.toThrow();
				// @ts-expect-error -- untyped bridge callers can send invalid preconditions.
				await expect(target.compareAndDelete("key", revision)).rejects.toThrow();
			}
			for (const key of [undefined, null, {}, [], "", "x".repeat(1025)]) {
				// @ts-expect-error -- untyped bridge callers can send invalid keys.
				await expect(target.compareAndSet(key, null, "bad")).rejects.toThrow();
			}
			expect((await target.getVersioned("key"))?.value).toBe("retained");
		});

		it(`${kind}: rejects missing and oversized JSON values instead of creating a row`, async () => {
			const target = store(kind);
			const cyclic: { self?: unknown } = {};
			cyclic.self = cyclic;
			for (const value of [
				undefined,
				BigInt(1),
				cyclic,
				"x".repeat(1024 * 1024),
				"€".repeat(350_000),
			]) {
				await expect(target.compareAndSet("key", null, value)).rejects.toThrow();
			}
			expect(await target.getVersioned("key")).toBeNull();
		});
	}

	it("keeps collection revisions separate within a plugin", async () => {
		const left = store("collection", "owner", "left");
		const right = store("collection", "owner", "right");
		await left.put("key", 1);
		await right.put("key", 2);
		const old = await left.getVersioned("key");
		if (!old) throw new Error("Missing value");
		expect(await right.compareAndSet("key", old.revision, 3)).toEqual({ applied: false });
		expect(await right.compareAndDelete("key", old.revision)).toEqual({ applied: false });
		expect((await right.getVersioned("key"))?.value).toBe(2);
	});

	it("propagates unrelated unique constraint failures", async () => {
		await db.schema
			.createIndex("conditional_unique_data")
			.unique()
			.on("_plugin_storage")
			.columns(["plugin_id", "collection", "data"])
			.execute();
		const target = new PluginStorageRepository(db, "owner", "jobs", []);
		await target.put("first", "unique");
		await expect(target.compareAndSet("second", null, "unique")).rejects.toThrow();
		expect(await target.getVersioned("second")).toBeNull();
		await target.put("second", "other");
		const before = await target.getVersioned("second");
		if (!before) throw new Error("Missing second value");
		await expect(target.compareAndSet("second", before.revision, "unique")).rejects.toThrow();
		expect(await target.getVersioned("second")).toEqual(before);
	});

	it("propagates database failures instead of reporting a conflict", async () => {
		const target = store("collection");
		await db.schema.dropTable("_plugin_storage").execute();
		await expect(target.compareAndSet("key", null, "value")).rejects.toThrow();
		await expect(target.compareAndDelete("key", "revision")).rejects.toThrow();
	});
});

describeEachDialect("conditional plugin storage after a legacy upgrade", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		db = ctx.db;
		await createLegacyPluginStorageTables(db);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function store(kind: "collection" | "kv", pluginId = "owner", collection = "jobs") {
		return kind === "collection"
			? createStorageAccess(db, pluginId, { [collection]: { indexes: [] } })[collection]
			: createKVAccess(new OptionsRepository(db), pluginId);
	}

	async function oldPut(
		kind: "collection" | "kv",
		key: string,
		pluginId = "owner",
		collection = "jobs",
	) {
		if (kind === "kv") {
			await sql`
				INSERT INTO options (name, value) VALUES (${`plugin:${pluginId}:${key}`}, ${'"same"'})
				ON CONFLICT (name) DO UPDATE SET value = excluded.value
			`.execute(db);
		} else {
			await sql`
				INSERT INTO _plugin_storage (plugin_id, collection, id, data)
				VALUES (${pluginId}, ${collection}, ${key}, ${'"same"'})
				ON CONFLICT (plugin_id, collection, id) DO UPDATE SET data = excluded.data
			`.execute(db);
		}
	}

	for (const kind of ["collection", "kv"] as const) {
		it(`${kind}: admits one writer at revision 0 without changing other legacy keys`, async () => {
			await oldPut(kind, "key");
			await oldPut(kind, "neighbor");
			await oldPut(kind, "key", "other");
			if (kind === "collection") await oldPut(kind, "key", "owner", "other");
			await migrateRevisions(db);
			const target = store(kind);
			const initial = await target.getVersioned("key");
			expect(initial).toEqual({ value: "same", revision: "0" });
			if (!initial) throw new Error("Missing legacy value");

			const writes = await Promise.all([
				target.compareAndSet("key", initial.revision, "first"),
				target.compareAndSet("key", initial.revision, "second"),
			]);

			expect(writes.filter((result) => result.applied)).toHaveLength(1);
			const winner = writes.find((result) => result.applied);
			if (!winner?.applied) throw new Error("Missing conditional write winner");
			expect(winner.revision).not.toBe("0");
			expect((await target.getVersioned("key"))?.revision).toBe(winner.revision);
			expect(await target.compareAndDelete("key", initial.revision)).toEqual({ applied: false });
			expect(await store(kind, "other").getVersioned("key")).toEqual(initial);
			if (kind === "collection") {
				expect(await store(kind, "owner", "other").getVersioned("key")).toEqual(initial);
			}
			expect(await target.getVersioned("neighbor")).toEqual(initial);
			const neighborWrite = await target.compareAndSet("neighbor", "0", "neighbor updated");
			if (!neighborWrite.applied) throw new Error("Expected legacy neighbor write");
			expect(neighborWrite.revision).not.toBe("0");
			expect(await target.getVersioned("neighbor")).toEqual({
				value: "neighbor updated",
				revision: neighborWrite.revision,
			});
		});

		it(`${kind}: rejects deletion at revision 0 after old writes and recreation`, async () => {
			for (const key of ["updated", "recreated"]) await oldPut(kind, key);
			await migrateRevisions(db);
			const target = store(kind);

			for (const key of ["updated", "recreated"]) {
				const initial = await target.getVersioned(key);
				expect(initial).toEqual({ value: "same", revision: "0" });
				if (!initial) throw new Error("Missing legacy value");
				if (key === "recreated") await target.delete(key);
				await oldPut(kind, key);
				const current = await target.getVersioned(key);
				expect(current?.value).toBe("same");
				expect(current?.revision).not.toBe(initial.revision);
				expect(await target.compareAndDelete(key, initial.revision)).toEqual({ applied: false });
				expect(await target.getVersioned(key)).toEqual(current);
			}
		});
	}
});
