import { type Kysely, type KyselyPlugin, sql } from "kysely";
import { expect, it } from "vitest";

import { down, up } from "../../src/database/migrations/076_plugin_storage_revisions.js";

const STORES = [
	{ table: "options", keys: ["name"], values: ["plugin:test:state"], data: "value" },
	{
		table: "_plugin_storage",
		keys: ["plugin_id", "collection", "id"],
		values: ["test", "items", "item"],
		data: "data",
	},
] as const;

type Store = (typeof STORES)[number];

export async function createLegacyPluginStorageTables(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL)
	`.execute(db);
	await sql`
		CREATE TABLE _plugin_storage (
			plugin_id TEXT NOT NULL,
			collection TEXT NOT NULL,
			id TEXT NOT NULL,
			data TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			PRIMARY KEY (plugin_id, collection, id)
		)
	`.execute(db);
}

function whereKey(store: Store) {
	return sql.join(
		store.keys.map((key, index) => sql`${sql.ref(key)} = ${store.values[index]}`),
		sql` AND `,
	);
}

async function oldPut(db: Kysely<unknown>, store: Store, value = '{"count":1}') {
	await sql`
		INSERT INTO ${sql.ref(store.table)}
			(${sql.join([...store.keys, store.data].map((column) => sql.ref(column)))})
		VALUES (${sql.join([...store.values, value].map((item) => sql`${item}`))})
		ON CONFLICT (${sql.join(store.keys.map((column) => sql.ref(column)))})
		DO UPDATE SET ${sql.ref(store.data)} = ${sql.ref(`excluded.${store.data}`)}
	`.execute(db);
}

async function readRow(db: Kysely<unknown>, store: Store) {
	const result = await sql<{ value: string; revision: string }>`
		SELECT ${sql.ref(store.data)} AS value, revision FROM ${sql.ref(store.table)}
		WHERE ${whereKey(store)}
	`.execute(db);
	const row = result.rows[0];
	if (!row) throw new Error(`Missing fixture row in ${store.table}`);
	return row;
}

function afterStatement(callback: () => void): KyselyPlugin {
	return {
		transformQuery: ({ node }) => node,
		transformResult: ({ result }) => {
			callback();
			return Promise.resolve(result);
		},
	};
}

export function pluginStorageRevisionMigrationCases(
	getDb: () => Kysely<unknown>,
	sqlite: boolean,
): void {
	it("backfills multiple keyset pages without changing legacy values or timestamps", async () => {
		const db = getDb();
		for (let start = 0; start < 503; start += 25) {
			const indexes = Array.from(
				{ length: Math.min(25, 503 - start) },
				(_, index) => start + index,
			);
			await sql`
				INSERT INTO options (name, value) VALUES ${sql.join(
					indexes.map((index) => sql`(${`plugin:test:${index}`}, ${JSON.stringify({ index })})`),
				)}
			`.execute(db);
			await sql`
				INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES ${sql.join(
					indexes.map(
						(index) => sql`(
							${`plugin-${Math.floor(index / 200)}`},
							${`collection-${Math.floor(index / 50) % 4}`},
							${`entry-${index % 50}`}, ${JSON.stringify({ index })}
						)`,
					),
				)}
			`.execute(db);
		}
		const before = await Promise.all(
			STORES.map((store) =>
				sql<Record<string, string>>`
					SELECT * FROM ${sql.ref(store.table)}
					ORDER BY ${sql.join(store.keys.map((column) => sql.ref(column)))}
				`.execute(db),
			),
		);

		await up(db);

		const revisions = new Set<string>();
		for (const [index, store] of STORES.entries()) {
			const after = await sql<Record<string, string>>`
				SELECT * FROM ${sql.ref(store.table)}
				ORDER BY ${sql.join(store.keys.map((column) => sql.ref(column)))}
			`.execute(db);
			expect(after.rows).toHaveLength(503);
			expect(
				after.rows.map(({ revision, ...row }) => {
					if (typeof revision !== "string") throw new Error("Missing backfilled revision");
					expect(revision).not.toBe("0");
					expect(revision.length).toBeGreaterThan(20);
					revisions.add(revision);
					return row;
				}),
			).toEqual(before[index]?.rows);
		}
		expect(revisions.size).toBe(1006);
	});

	it("preserves assigned revisions and payloads when the migration runs again", async () => {
		const db = getDb();
		for (const store of STORES) await oldPut(db, store);
		await up(db);
		const before = await Promise.all(STORES.map((store) => readRow(db, store)));

		await up(db);
		await up(db);

		expect(await Promise.all(STORES.map((store) => readRow(db, store)))).toEqual(before);
	});

	it("keeps revision protection when an older host rolls migrations back", async () => {
		const db = getDb();
		await up(db);
		for (const store of STORES) await oldPut(db, store);
		const before = await Promise.all(STORES.map((store) => readRow(db, store)));

		await down(db);

		expect(await Promise.all(STORES.map((store) => readRow(db, store)))).toEqual(before);
		for (const [index, store] of STORES.entries()) {
			await oldPut(db, store);
			expect((await readRow(db, store)).revision).not.toBe(before[index]?.revision);
		}
	});

	it("changes revisions for old inserts, upserts and same-value writes", async () => {
		const db = getDb();
		await up(db);
		for (const store of STORES) {
			await oldPut(db, store);
			const inserted = await readRow(db, store);
			expect(inserted?.revision).not.toBe("0");
			await oldPut(db, store, '{"count":2}');
			const updated = await readRow(db, store);
			expect(updated?.value).toBe('{"count":2}');
			expect(updated?.revision).not.toBe(inserted?.revision);
			await oldPut(db, store, '{"count":2}');
			const unchanged = await readRow(db, store);
			expect(unchanged?.revision).not.toBe(updated?.revision);
			await sql`
				UPDATE ${sql.ref(store.table)} SET ${sql.ref(store.data)} = ${sql.ref(store.data)}
				WHERE ${whereKey(store)}
			`.execute(db);
			expect((await readRow(db, store))?.revision).not.toBe(unchanged?.revision);
		}
	});

	it("keeps explicitly assigned write revisions consistent with RETURNING", async () => {
		const db = getDb();
		await up(db);
		for (const store of STORES) {
			const insertedRevision = crypto.randomUUID();
			const inserted = await sql<{ revision: string }>`
				INSERT INTO ${sql.ref(store.table)}
					(${sql.join([...store.keys, store.data, "revision"].map((column) => sql.ref(column)))})
				VALUES (${sql.join([...store.values, "null", insertedRevision].map((value) => sql`${value}`))})
				RETURNING revision
			`.execute(db);
			expect(inserted.rows).toEqual([{ revision: insertedRevision }]);
			expect(await readRow(db, store)).toEqual({ value: "null", revision: insertedRevision });
			const updatedRevision = crypto.randomUUID();
			const updated = await sql<{ revision: string }>`
				UPDATE ${sql.ref(store.table)} SET revision = ${updatedRevision}
				WHERE ${whereKey(store)} AND revision = ${insertedRevision}
				RETURNING revision
			`.execute(db);
			expect(updated.rows).toEqual([{ revision: updatedRevision }]);
			expect((await readRow(db, store))?.revision).toBe(updatedRevision);
		}
	});

	it("rejects a stale revision after an old writer deletes and recreates the same value", async () => {
		const db = getDb();
		await up(db);
		for (const store of STORES) {
			await oldPut(db, store);
			const before = await readRow(db, store);
			await sql`DELETE FROM ${sql.ref(store.table)} WHERE ${whereKey(store)}`.execute(db);
			await oldPut(db, store);
			const recreated = await readRow(db, store);
			expect(recreated?.value).toBe(before?.value);
			expect(recreated?.revision).not.toBe(before?.revision);
			const staleDelete = await sql<{ revision: string }>`
				DELETE FROM ${sql.ref(store.table)}
				WHERE ${whereKey(store)} AND revision = ${before?.revision}
				RETURNING revision
			`.execute(db);
			expect(staleDelete.rows).toEqual([]);
			expect(await readRow(db, store)).toEqual(recreated);
		}
	});

	it("resumes after a response is lost following every completed migration statement", async () => {
		const db = getDb();
		for (const store of STORES) await oldPut(db, store);
		let statements = 0;
		await up(db.withPlugin(afterStatement(() => statements++)));

		for (let failAfter = 1; failAfter <= statements; failAfter++) {
			for (const store of STORES) await sql`DROP TABLE ${sql.ref(store.table)}`.execute(db);
			await createLegacyPluginStorageTables(db);
			for (const store of STORES) await oldPut(db, store);
			let completed = 0;
			const failing = db.withPlugin(
				afterStatement(() => {
					if (++completed === failAfter) throw new Error("Lost migration response");
				}),
			);
			await expect(up(failing), `statement ${failAfter}`).rejects.toThrow(
				"Lost migration response",
			);
			await up(db);
			const recovered = await Promise.all(STORES.map((store) => readRow(db, store)));
			for (const row of recovered) {
				expect(row?.value).toBe('{"count":1}');
				expect(row?.revision).not.toBe("0");
			}
			await up(db);
			expect(await Promise.all(STORES.map((store) => readRow(db, store)))).toEqual(recovered);
		}
	});

	if (sqlite) {
		it("tolerates concurrent migration starts without losing existing values", async () => {
			const db = getDb();
			for (const store of STORES) await oldPut(db, store);

			await Promise.all([up(db), up(db)]);

			for (const store of STORES) {
				const row = await readRow(db, store);
				expect(row.value).toBe('{"count":1}');
				expect(row.revision).not.toBe("0");
			}
		});

		it("changes revisions after INSERT OR REPLACE from an older Cloudflare bridge", async () => {
			const db = getDb();
			await up(db);
			for (const store of STORES) {
				await oldPut(db, store);
				const before = await readRow(db, store);
				await sql`
					INSERT OR REPLACE INTO ${sql.ref(store.table)}
						(${sql.join([...store.keys, store.data].map((column) => sql.ref(column)))})
					VALUES (${sql.join([...store.values, '{"count":1}'].map((value) => sql`${value}`))})
				`.execute(db);
				const replaced = await readRow(db, store);
				expect(replaced?.value).toBe(before?.value);
				expect(replaced?.revision).not.toBe("0");
				expect(replaced?.revision).not.toBe(before?.revision);
			}
		});

		it("terminates revision triggers with recursive triggers enabled", async () => {
			const db = getDb();
			await sql`PRAGMA recursive_triggers = ON`.execute(db);
			try {
				await up(db);
				for (const store of STORES) {
					await oldPut(db, store);
					const before = await readRow(db, store);
					await oldPut(db, store);
					expect((await readRow(db, store))?.revision).not.toBe(before?.revision);
				}
			} finally {
				await sql`PRAGMA recursive_triggers = OFF`.execute(db);
			}
		});
	}
}
