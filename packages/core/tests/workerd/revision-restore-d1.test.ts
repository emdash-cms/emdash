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
import { createTestRuntime } from "../utils/mcp-runtime.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const COLLECTION = "restore_d1";
const REVISION_COLLECTION = "restore_d1_revisions";
const FAILURE_AUTHOR = "fail-restore-audit";

let db: Kysely<Database>;
let contentRepo: ContentRepository;
let revisionRepo: RevisionRepository;
let runtime: ReturnType<typeof createTestRuntime>;

beforeAll(() => {
	// Local D1 can report cumulative `meta.changes` across a batch; returned
	// rows remain statement-local and are the restore contract's success signal.
	db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: withCumulativeBatchChanges(env.DB) }),
	});
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "D1 restore" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	await registry.createCollection({
		slug: REVISION_COLLECTION,
		label: "D1 revision restore",
		supports: ["revisions"],
	});
	await registry.createField(REVISION_COLLECTION, {
		slug: "title",
		label: "Title",
		type: "string",
	});

	contentRepo = new ContentRepository(db);
	revisionRepo = new RevisionRepository(db);
	runtime = createTestRuntime(db);
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

	it("rolls back a revision-enabled draft restore when its audit insert fails", async () => {
		const content = await contentRepo.create({
			type: REVISION_COLLECTION,
			data: { title: "Current draft" },
		});
		const target = await revisionRepo.create({
			collection: REVISION_COLLECTION,
			entryId: content.id,
			data: { title: "Restored draft" },
		});
		const revisionCount = await revisionRepo.countByEntry(REVISION_COLLECTION, content.id);

		await sql`
			CREATE TRIGGER fail_revision_enabled_restore_audit
			BEFORE INSERT ON revisions
			WHEN NEW.author_id = ${sql.lit(FAILURE_AUTHOR)}
			BEGIN
				SELECT RAISE(FAIL, 'forced revision audit failure');
			END
		`.execute(db);

		const result = await runtime.handleRevisionRestore(target.id, FAILURE_AUTHOR);

		expect(result).toMatchObject({
			success: false,
			error: { code: "REVISION_RESTORE_ERROR" },
		});
		await expect(runtime.handleContentGet(REVISION_COLLECTION, content.id)).resolves.toMatchObject({
			success: true,
			data: { item: { data: { title: "Current draft" } } },
		});
		await expect(revisionRepo.countByEntry(REVISION_COLLECTION, content.id)).resolves.toBe(
			revisionCount,
		);
	});

	it("commits one revision-enabled draft when concurrent restores race", async () => {
		const content = await contentRepo.create({
			type: REVISION_COLLECTION,
			data: { title: "Current draft" },
		});
		const first = await revisionRepo.create({
			collection: REVISION_COLLECTION,
			entryId: content.id,
			data: { title: "First draft" },
		});
		const second = await revisionRepo.create({
			collection: REVISION_COLLECTION,
			entryId: content.id,
			data: { title: "Second draft" },
		});
		const revisionCount = await revisionRepo.countByEntry(REVISION_COLLECTION, content.id);

		const results = await Promise.all([
			runtime.handleRevisionRestore(first.id, "first-author"),
			runtime.handleRevisionRestore(second.id, "second-author"),
		]);
		const succeeded = results.filter((result) => result.success);
		const conflicted = results.filter(
			(result) => !result.success && result.error.code === "CONFLICT",
		);

		expect(succeeded).toHaveLength(1);
		expect(conflicted).toHaveLength(1);
		await expect(runtime.handleContentGet(REVISION_COLLECTION, content.id)).resolves.toMatchObject({
			success: true,
			data: { item: { data: succeeded[0]?.data.item.data } },
		});
		await expect(revisionRepo.countByEntry(REVISION_COLLECTION, content.id)).resolves.toBe(
			revisionCount + 1,
		);
	});

	it("restores an older revision after publishing twice", async () => {
		const created = await runtime.handleContentCreate(REVISION_COLLECTION, {
			data: { title: "Original title" },
			slug: "published-restore",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		expect((await runtime.handleContentPublish(REVISION_COLLECTION, id)).success).toBe(true);
		expect(
			(
				await runtime.handleContentUpdate(REVISION_COLLECTION, id, {
					data: { title: "Changed title" },
				})
			).success,
		).toBe(true);
		expect((await runtime.handleContentPublish(REVISION_COLLECTION, id)).success).toBe(true);

		const revisions = await runtime.handleRevisionList(REVISION_COLLECTION, id);
		expect(revisions.success).toBe(true);
		const target = revisions.data!.items.at(1);
		expect(target).toBeDefined();

		const restored = await runtime.handleRevisionRestore(target!.id, "restore-author");

		expect(restored).toMatchObject({
			success: true,
			data: { item: { data: { title: "Original title" } } },
		});
	});
});

function withCumulativeBatchChanges(database: D1Database): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "batch") {
				return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
					const results = await target.batch<T>(statements);
					let changes = 0;
					return results.map((result) => {
						changes += result.meta.changes;
						return { ...result, meta: { ...result.meta, changes } };
					});
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
