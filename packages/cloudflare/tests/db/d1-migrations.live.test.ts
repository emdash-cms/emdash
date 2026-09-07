import { getCoreMigrationIdentity } from "emdash/migrations";
import { Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createMigrationExecutor } from "../../src/db/d1-migrations.js";
import { D1RestDialect } from "../../src/db/d1-rest-dialect.js";

const accountId = process.env.EMDASH_TEST_D1_ACCOUNT_ID ?? "";
const databaseId = process.env.EMDASH_TEST_D1_DATABASE_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const hasLiveD1 =
	process.env.EMDASH_TEST_D1_DISPOSABLE === "1" &&
	accountId.length > 0 &&
	databaseId.length > 0 &&
	token.length > 0;

describe.skipIf(!hasLiveD1)("D1 migration executor live", () => {
	it("applies the registry to an explicitly disposable database and is idempotent", async () => {
		const context = {
			projectRoot: process.cwd(),
			env: { CLOUDFLARE_API_TOKEN: token },
			overrides: { accountId, d1: databaseId },
		};
		const identity = await getCoreMigrationIdentity();
		const request = {
			action: "apply" as const,
			i18n: null,
			artifact: {
				emdashVersion: identity.emdashVersion,
				migrationSetFingerprint: identity.fingerprint,
			},
		};

		const first = await createMigrationExecutor({ binding: "DB" }, context);
		await expect(first.execute(request)).resolves.toMatchObject({ pending: [] });
		const second = await createMigrationExecutor({ binding: "DB" }, context);
		await expect(second.execute(request)).resolves.toMatchObject({ pending: [], executed: [] });
	});

	it("supports migration introspection, values, and duplicate-error recovery", async () => {
		const db = new Kysely<Record<string, never>>({
			dialect: new D1RestDialect({ accountId, databaseId, token }),
		});
		try {
			await sql`drop table if exists _emdash_d1_live_contract`.execute(db);
			await sql`create table _emdash_d1_live_contract (
				id integer primary key,
				text_value text not null unique,
				number_value real not null,
				null_value text,
				boolean_value integer not null,
				blob_value blob not null
			)`.execute(db);
			await sql`insert into _emdash_d1_live_contract
				(id, text_value, number_value, null_value, boolean_value, blob_value)
				values (${1}, ${"contract"}, ${1.5}, ${null}, ${true}, ${new Uint8Array([0, 127, 255])})`.execute(
				db,
			);

			const result = await sql<{
				text_value: string;
				number_value: number;
				null_value: null;
				boolean_value: number;
				blob_value: number[];
			}>`select text_value, number_value, null_value, boolean_value, blob_value
					from _emdash_d1_live_contract where id = ${1}`.execute(db);
			expect(result.rows[0]).toEqual({
				text_value: "contract",
				number_value: 1.5,
				null_value: null,
				boolean_value: 1,
				blob_value: [0, 127, 255],
			});
			await expect(db.introspection.getTables()).resolves.toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "_emdash_d1_live_contract" })]),
			);
			await expect(
				sql`insert into _emdash_d1_live_contract
					(id, text_value, number_value, boolean_value, blob_value)
					values (${2}, ${"contract"}, ${2}, ${false}, ${new Uint8Array()})`.execute(db),
			).rejects.toThrow(/UNIQUE constraint failed: _emdash_d1_live_contract\.text_value/);
		} finally {
			await sql`drop table if exists _emdash_d1_live_contract`.execute(db);
			await db.destroy();
		}
	});
});
