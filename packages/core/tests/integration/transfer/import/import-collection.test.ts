import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPostgres, listTableColumns } from "../../../../src/database/dialect-helpers.js";
import type { Database } from "../../../../src/database/types.js";
import { activateMediaUsageCapture } from "../../../../src/media/usage/activation.js";
import { verifyMediaUsageCaptureTriggers } from "../../../../src/media/usage/capture-triggers.js";
import { SchemaError, SchemaRegistry } from "../../../../src/schema/registry.js";
import type { CollectionRecord, FieldRecord } from "../../../../src/transfer/format/kinds.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { fixtureId } from "../../../utils/transfer/golden-package.js";
import { withFaults } from "./harness.js";

const T0 = "2026-01-01T00:00:00.000Z";

interface CollectionFixture {
	record: CollectionRecord;
	fields: FieldRecord[];
}

/** A posts-like collection with its own ids and slug for fixture number `n`. */
function collectionFixture(n: number, extraFields = 0): CollectionFixture {
	const base = 10_000 + n * 1000;
	const id = fixtureId(base);
	const record: CollectionRecord = {
		kind: "collection",
		id,
		slug: `imported_${n}`,
		label: "Imported",
		labelSingular: "Imported",
		supports: ["drafts", "revisions", "search"],
		source: "manual",
		searchConfig: { enabled: true, weights: { title: 5 } },
		hasSeo: true,
		urlPattern: "/imported/{slug}",
		commentsEnabled: true,
		commentsModeration: "all",
		commentsClosedAfterDays: 30,
		commentsAutoApproveUsers: false,
		hidden: false,
		sortOrder: 3,
		adminConfig: { listColumns: ["title"] },
		titleField: "title",
		dateField: "published_at",
		routable: true,
		editLocking: false,
		navGroup: "Imports",
		createdAt: T0,
		updatedAt: T0,
	};
	const field = (
		offset: number,
		slug: string,
		type: string,
		columnType: FieldRecord["columnType"],
		extra: Partial<FieldRecord> = {},
	): FieldRecord => ({
		kind: "field",
		id: fixtureId(base + offset),
		collectionId: id,
		slug,
		label: slug,
		type,
		columnType,
		required: false,
		unique: false,
		sortOrder: offset,
		searchable: false,
		translatable: true,
		indexed: false,
		createdAt: T0,
		...extra,
	});
	const fields = [
		field(1, "title", "string", "TEXT", { required: true, searchable: true, indexed: true }),
		field(2, "content", "portableText", "JSON", { searchable: true }),
		field(3, "rating", "number", "REAL", { required: true, defaultValue: 2.5 }),
		field(4, "related", "reference", "TEXT", { indexed: true, options: { collection: "pages" } }),
	];
	for (let index = 0; index < extraFields; index++) {
		fields.push(field(10 + index, `extra_${index}`, "string", "TEXT"));
	}
	return { record, fields };
}

async function indexNames(db: Kysely<Database>, table: string): Promise<string[]> {
	const rows = isPostgres(db)
		? await sql<{ name: string }>`
				SELECT indexname AS name FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = ${table}
			`.execute(db)
		: await sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table}
			`.execute(db);
	return rows.rows.map((row) => row.name).filter((name) => !name.startsWith("sqlite_autoindex"));
}

/** Schema shape of an imported collection with its slug and field ids abstracted away. */
async function collectionShape(db: Kysely<Database>, fixture: CollectionFixture) {
	const { record, fields } = fixture;
	const table = `ec_${record.slug}`;
	const normalize = (value: string) => {
		let text = value.replaceAll(record.slug, "<slug>").replaceAll(record.id, "<id>");
		for (const field of fields) text = text.replaceAll(field.id.toLowerCase(), `<${field.slug}>`);
		for (const field of fields) text = text.replaceAll(field.id, `<${field.slug}>`);
		return text;
	};
	const collection = await db
		.selectFrom("_emdash_collections")
		.selectAll()
		.where("id", "=", record.id)
		.executeTakeFirst();
	const storedFields = await db
		.selectFrom("_emdash_fields")
		.selectAll()
		.where("collection_id", "=", record.id)
		.orderBy("sort_order")
		.execute();
	const lifecycle = await db
		.selectFrom("_emdash_media_usage_index_status")
		.select(["collection_id", "capture_state", "cursor"])
		.where("scope_key", "=", record.slug)
		.executeTakeFirst();
	return {
		collection: normalize(JSON.stringify(collection)),
		fields: storedFields.map((row) => normalize(JSON.stringify(row))),
		columns: (await listTableColumns(db, table)).map((column) => `${column.name}:${column.type}`),
		indexes: (await indexNames(db, table)).map(normalize).toSorted(),
		lifecycle: lifecycle ? normalize(JSON.stringify(lifecycle)) : null,
		triggers: await verifyMediaUsageCaptureTriggers(db, {
			collectionId: record.id,
			collectionSlug: record.slug,
		}),
	};
}

for (const capture of ["expanded", "active"] as const) {
	describeEachDialect(`SchemaRegistry.importCollection (media usage ${capture})`, (dialect) => {
		let ctx: DialectTestContext;

		beforeEach(async () => {
			ctx = await setupForDialect(dialect);
			if (capture === "active") {
				await activateMediaUsageCapture(ctx.db, { writersDrained: true });
			}
		});

		afterEach(async () => {
			await teardownForDialect(ctx);
		});

		it("writes the collection and fields with their exact ids and columns", async () => {
			const fixture = collectionFixture(1);
			const result = await new SchemaRegistry(ctx.db).importCollection(
				fixture.record,
				fixture.fields,
				{ resume: true },
			);
			expect(result).toEqual({ collectionCreated: true, fieldsCreated: 4 });

			const collection = await ctx.db
				.selectFrom("_emdash_collections")
				.selectAll()
				.where("slug", "=", fixture.record.slug)
				.executeTakeFirstOrThrow();
			expect(collection).toMatchObject({
				id: fixture.record.id,
				label: "Imported",
				comments_moderation: "all",
				comments_closed_after_days: 30,
				comments_auto_approve_users: 0,
				edit_locking: 0,
				nav_group: "Imports",
				title_field: "title",
				date_field: "published_at",
				created_at: T0,
			});
			expect(JSON.parse(collection.search_config ?? "null")).toEqual({
				enabled: false,
				weights: { title: 5 },
			});
			const fields = await ctx.db
				.selectFrom("_emdash_fields")
				.select(["id", "slug", "indexed", "default_value", "required"])
				.where("collection_id", "=", fixture.record.id)
				.orderBy("sort_order")
				.execute();
			expect(fields).toEqual(
				fixture.fields.map((field) => ({
					id: field.id,
					slug: field.slug,
					indexed: field.indexed ? 1 : 0,
					default_value:
						field.defaultValue === undefined ? null : JSON.stringify(field.defaultValue),
					required: field.required ? 1 : 0,
				})),
			);

			const shape = await collectionShape(ctx.db, fixture);
			expect(shape.columns.map((column) => column.split(":")[0])).toEqual(
				expect.arrayContaining(["id", "slug", "title", "content", "rating", "related"]),
			);
			expect(shape.indexes).toEqual(
				expect.arrayContaining([
					"idx_ec_<slug>_slug",
					"idx_ec_<slug>_del_sched",
					"uidx_ec_<slug>_active_tg_locale",
					"idx_cf_<title>",
					"idx_cf_<related>_loc",
				]),
			);
			expect(shape.triggers).toBe(capture === "active");
			if (capture === "active") expect(shape.lifecycle).toContain('"capture_state":"active"');
		});

		it("is a no-op when repeated after completing", async () => {
			const fixture = collectionFixture(2);
			const registry = new SchemaRegistry(ctx.db);
			await registry.importCollection(fixture.record, fixture.fields, { resume: true });
			const before = await collectionShape(ctx.db, fixture);
			const again = await registry.importCollection(fixture.record, fixture.fields, {
				resume: true,
			});
			expect(again).toEqual({ collectionCreated: false, fieldsCreated: 0 });
			expect(await collectionShape(ctx.db, fixture)).toEqual(before);
		});

		it("resumes after a crash after any statement", { timeout: 300_000 }, async () => {
			const reference = collectionFixture(0);
			await new SchemaRegistry(ctx.db).importCollection(reference.record, reference.fields, {
				resume: true,
			});
			const expected = await collectionShape(ctx.db, reference);

			const { db, faults } = withFaults(ctx.db);
			let crashes = 0;
			for (let n = 1; ; n++) {
				const fixture = collectionFixture(n);
				faults.failAfter(n);
				try {
					await new SchemaRegistry(db).importCollection(fixture.record, fixture.fields, {
						resume: true,
					});
					const crashed = faults.crashed;
					faults.disarm();
					if (!crashed) break;
				} catch (error) {
					faults.disarm();
					expect((error as Error).message).toContain("injected crash");
				}
				crashes++;
				await new SchemaRegistry(ctx.db).importCollection(fixture.record, fixture.fields, {
					resume: true,
				});
				expect(await collectionShape(ctx.db, fixture), `crash after statement ${n}`).toEqual(
					expected,
				);
			}
			expect(crashes).toBeGreaterThan(20);
		});

		it("stays within D1's statement budget and bind-parameter limit", async () => {
			const { db, faults } = withFaults(ctx.db);
			const narrow = collectionFixture(3);
			await new SchemaRegistry(db).importCollection(narrow.record, narrow.fields, {
				resume: true,
			});
			const narrowStatements = faults.executed;

			const wide = collectionFixture(4, 120);
			const before = faults.executed;
			await new SchemaRegistry(db).importCollection(wide.record, wide.fields, { resume: true });
			const wideStatements = faults.executed - before;

			expect(faults.maxParameters).toBeLessThanOrEqual(100);
			expect(narrowStatements).toBeLessThanOrEqual(80);
			expect(wideStatements).toBeLessThanOrEqual(narrowStatements + Math.ceil(124 / 5) + 2);
		});

		it("rejects a stored collection or field that differs from the record", async () => {
			const fixture = collectionFixture(5);
			const registry = new SchemaRegistry(ctx.db);
			await registry.importCollection(fixture.record, fixture.fields, { resume: true });

			await expect(
				registry.importCollection({ ...fixture.record, label: "Changed" }, fixture.fields, {
					resume: true,
				}),
			).rejects.toMatchObject({ code: "IMPORT_MISMATCH" });

			const [first, ...rest] = fixture.fields;
			await expect(
				registry.importCollection(fixture.record, [{ ...first!, label: "Changed" }, ...rest], {
					resume: true,
				}),
			).rejects.toBeInstanceOf(SchemaError);

			const other = collectionFixture(6);
			await expect(
				registry.importCollection(
					{ ...other.record, slug: fixture.record.slug },
					other.fields.map((field) => ({ ...field })),
					{ resume: true },
				),
			).rejects.toMatchObject({ code: "COLLECTION_EXISTS" });
		});
	});
}

describe("importCollection field validation", () => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect("sqlite");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("refuses a field whose column type does not match its type", async () => {
		const fixture = collectionFixture(7);
		const [first, ...rest] = fixture.fields;
		await expect(
			new SchemaRegistry(ctx.db).importCollection(
				fixture.record,
				[{ ...first!, columnType: "INTEGER" }, ...rest],
				{ resume: true },
			),
		).rejects.toMatchObject({ code: "INVALID_FIELD_TYPE" });
		expect(await ctx.db.selectFrom("_emdash_collections").select("id").execute()).toEqual([]);
	});
});
