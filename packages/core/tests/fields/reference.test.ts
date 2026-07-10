import { sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { reference } from "../../src/fields/reference.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { STORAGELESS_FIELD_TYPES, FIELD_TYPE_TO_COLUMN } from "../../src/schema/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describe("reference field", () => {
	it("should create field definition", () => {
		const field = reference("posts");

		expect(field.type).toBe("reference");
		expect(field.schema).toBeDefined();
		expect(field.ui?.widget).toBe("reference");
		expect(field.options?.collection).toBe("posts");
	});

	it("should accept valid reference ID", () => {
		const field = reference("posts");

		expect(() => field.schema.parse("post-123")).not.toThrow();
		expect(() => field.schema.parse("abc-def-ghi")).not.toThrow();
	});

	it("should reject invalid reference", () => {
		const field = reference("posts");

		expect(() => field.schema.parse(123)).toThrow();
		expect(() => field.schema.parse({})).toThrow();
		expect(() => field.schema.parse(null)).toThrow();
	});

	it("should support required option", () => {
		const required = reference("posts", { required: true });
		const optional = reference("posts", { required: false });

		// Required should reject undefined
		expect(() => required.schema.parse(undefined)).toThrow();

		// Optional should accept undefined
		expect(() => optional.schema.parse(undefined)).not.toThrow();
	});
});

describe("storage-less field types", () => {
	it("marks reference as storage-less but keeps its column-type guard entry", () => {
		expect(STORAGELESS_FIELD_TYPES.has("reference")).toBe(true);
		expect(STORAGELESS_FIELD_TYPES.has("string")).toBe(false);
		// The map still contains reference so isFieldType() keeps recognizing it.
		expect(FIELD_TYPE_TO_COLUMN.reference).toBe("TEXT");
	});
});

describeEachDialect("reference field is storage-less in the registry", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates the field row without adding a column, and deletes without dropping one", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("posts", {
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { relation: "grp_x", targetCollection: "posts", multiple: true },
		});

		// The field row exists...
		const field = await registry.getField("posts", "related");
		expect(field?.type).toBe("reference");

		// ...but no column was added to ec_posts. (pragma_table_info is SQLite-only.)
		if (dialect === "sqlite") {
			const cols = await sql<{ name: string }>`
				SELECT name FROM pragma_table_info('ec_posts')
			`.execute(ctx.db);
			expect(cols.rows.map((c) => c.name)).not.toContain("related");
		}

		// Deleting the field succeeds and drops nothing.
		await expect(registry.deleteField("posts", "related")).resolves.not.toThrow();
		expect(await registry.getField("posts", "related")).toBeNull();
	});

	it("rejects changing a field to or from reference", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("posts", { slug: "title2", label: "Title2", type: "string" });
		await expect(
			registry.updateField("posts", "title2", { type: "reference" }),
		).rejects.toMatchObject({ code: "FIELD_TYPE_COLUMN_CHANGE" });
	});
});
