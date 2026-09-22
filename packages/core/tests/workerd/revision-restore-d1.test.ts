import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleRevisionRestore } from "../../src/api/handlers/revision.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const COLLECTION = "restore_d1";
const FAILURE_AUTHOR = "fail-restore-audit";

let db: Kysely<Database>;
let contentRepo: ContentRepository;
let revisionRepo: RevisionRepository;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "D1 restore" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });

	contentRepo = new ContentRepository(db);
	revisionRepo = new RevisionRepository(db);
});

afterAll(async () => {
	await db.destroy();
});

describe("revision restore on D1", () => {
	it("rolls back the content update when the audit revision fails", async () => {
		const content = await contentRepo.create({
			type: COLLECTION,
			data: { title: "Current title" },
		});
		const target = await revisionRepo.create({
			collection: COLLECTION,
			entryId: content.id,
			data: { title: "Restored title" },
		});
		const revisionCount = await revisionRepo.countByEntry(COLLECTION, content.id);

		await sql`
			CREATE TRIGGER fail_revision_restore_audit
			BEFORE INSERT ON revisions
			WHEN NEW.author_id = ${sql.lit(FAILURE_AUTHOR)}
			BEGIN
				SELECT RAISE(FAIL, 'forced revision audit failure');
			END
		`.execute(db);

		const result = await handleRevisionRestore(db, target.id, FAILURE_AUTHOR);

		expect(result).toMatchObject({
			success: false,
			error: { code: "REVISION_RESTORE_ERROR" },
		});
		await expect(contentRepo.findById(COLLECTION, content.id)).resolves.toMatchObject({
			data: { title: "Current title" },
		});
		await expect(revisionRepo.countByEntry(COLLECTION, content.id)).resolves.toBe(revisionCount);
	});

	it("commits one audit revision when concurrent restores race", async () => {
		const content = await contentRepo.create({
			type: COLLECTION,
			data: { title: "Current title" },
		});
		const first = await revisionRepo.create({
			collection: COLLECTION,
			entryId: content.id,
			data: { title: "First restore" },
		});
		const second = await revisionRepo.create({
			collection: COLLECTION,
			entryId: content.id,
			data: { title: "Second restore" },
		});
		const revisionCount = await revisionRepo.countByEntry(COLLECTION, content.id);

		const results = await Promise.all([
			handleRevisionRestore(db, first.id, "first-author"),
			handleRevisionRestore(db, second.id, "second-author"),
		]);
		const succeeded = results.filter((result) => result.success);
		const conflicted = results.filter(
			(result) => !result.success && result.error.code === "CONFLICT",
		);

		expect(succeeded).toHaveLength(1);
		expect(conflicted).toHaveLength(1);
		const restoredTitle = succeeded[0]?.data.item.data.title;
		await expect(contentRepo.findById(COLLECTION, content.id)).resolves.toMatchObject({
			data: { title: restoredTitle },
		});
		await expect(revisionRepo.countByEntry(COLLECTION, content.id)).resolves.toBe(
			revisionCount + 1,
		);
	});
});
