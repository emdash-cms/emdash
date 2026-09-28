import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { tableExists } from "../../../src/database/dialect-helpers.js";
import * as migration from "../../../src/database/migrations/084_site_transfer.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const TABLES = [
	"_emdash_transfer_operations",
	"_emdash_transfer_identity_map",
	"_emdash_transfer_staged_files",
	"_emdash_transfer_package_index",
	"_emdash_transfer_media_blobs",
	"_emdash_transfer_approvals",
];

describeEachDialect("migration 084_site_transfer", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates every transfer table", async () => {
		for (const table of TABLES) expect(await tableExists(ctx.db, table), table).toBe(true);
	});

	it("can be re-run after completing and preserves existing rows", async () => {
		const repo = new TransferOperationRepository(ctx.db);
		const { operation } = await repo.create({ kind: "import", createdBy: "u1" });
		await migration.up(ctx.db as unknown as Kysely<unknown>);
		expect((await repo.require(operation.id)).state).toBe("uploading");
		await expect(repo.create({ kind: "import", createdBy: "u2" })).rejects.toMatchObject({
			code: "TRANSFER_IMPORT_IN_PROGRESS",
		});
	});

	it("rolls back and re-applies cleanly", async () => {
		await migration.down(ctx.db as unknown as Kysely<unknown>);
		for (const table of TABLES) expect(await tableExists(ctx.db, table), table).toBe(false);
		await migration.up(ctx.db as unknown as Kysely<unknown>);
		for (const table of TABLES) expect(await tableExists(ctx.db, table), table).toBe(true);
	});
});
