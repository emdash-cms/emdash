import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	decodeContentRow,
	decodeRow,
	encodeContentRow,
	encodeRow,
	selectExportedColumns,
} from "../../../src/transfer/format/column-codec.js";
import { getColumnSpecs, getPortableTableSpec } from "../../../src/transfer/format/columns.js";
import type { EntryRecord } from "../../../src/transfer/format/kinds.js";
import { applyTransformations } from "../../../src/transfer/format/transformations.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("transfer column codec", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "items", label: "Items" });
		await registry.createField("items", { slug: "title", label: "Title", type: "string" });
		await registry.createField("items", { slug: "count", label: "Count", type: "integer" });
		await registry.createField("items", { slug: "rating", label: "Rating", type: "number" });
		await registry.createField("items", { slug: "active", label: "Active", type: "boolean" });
		await registry.createField("items", { slug: "meta", label: "Meta", type: "json" });
		await registry.createField("items", { slug: "body", label: "Body", type: "portableText" });
		await registry.createField("items", { slug: "image", label: "Image", type: "image" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function roundTrip(
		id: string,
		fields: Record<string, unknown>,
	): Promise<{ properties: Record<string, unknown>; fields: Record<string, unknown> }> {
		const specs = await getColumnSpecs(ctx.db, "ec_items");
		const row = encodeContentRow(ctx.db, specs, { id, locale: "en", version: 1 }, fields);
		await ctx.db
			.insertInto("ec_items" as never)
			.values(row as never)
			.execute();
		const read = await ctx.db
			.selectFrom("ec_items" as never)
			.select(selectExportedColumns(ctx.db, specs))
			.where(sql.ref("id"), "=", id)
			.executeTakeFirstOrThrow();
		return decodeContentRow(ctx.db, specs, read as Record<string, unknown>);
	}

	it("round-trips every field codec through a real content table", async () => {
		const fields = {
			title: "Hello",
			count: 42,
			rating: 4.5,
			active: 0,
			meta: { nested: [1, "two", null, { three: true }] },
			body: [{ _type: "block", children: [{ _type: "span", text: "x" }] }],
			image: JSON.stringify({ id: "m1", meta: { storageKey: "emdash-media:m1" } }),
		};
		const decoded = await roundTrip("e1", fields);
		expect(decoded.fields).toEqual(fields);
		expect(decoded.properties).toEqual({ id: "e1", locale: "en", version: 1 });
	});

	it("round-trips JSON strings, numbers, and booleans in JSON columns", async () => {
		for (const [index, meta] of [
			"plain text",
			"123",
			'{"not":"parsed"}',
			7,
			2.5,
			true,
			[],
		].entries()) {
			const decoded = await roundTrip(`j${index}`, { meta });
			expect(decoded.fields.meta, JSON.stringify(meta)).toEqual(meta);
		}
	});

	it("stores boolean fields as the 0/1 integers their INTEGER column holds", async () => {
		const decoded = await roundTrip("b1", { active: 1 });
		expect(decoded.fields.active).toBe(1);
		await expect(roundTrip("b2", { active: true })).rejects.toMatchObject({
			code: "TRANSFER_RECORD_INVALID",
		});
	});

	it("omits NULL columns", async () => {
		const decoded = await roundTrip("n1", { title: "Only" });
		expect(decoded.fields).toEqual({ title: "Only" });
		expect("slug" in decoded.properties).toBe(false);
	});

	it("decodes REAL columns to exactly the value applyTransformations predicts", async () => {
		const values = [0.1, 1.23456789, 1e-7, 123456.789];
		const context = {
			fieldColumnTypes: new Map([["items", new Map([["rating", "REAL"]] as const)]]),
		};
		const declared =
			dialect === "postgres" ? [{ code: "float4_rounded" as const, count: values.length }] : [];
		for (const [index, rating] of values.entries()) {
			const record: EntryRecord = {
				kind: "entry",
				id: `r${index}`,
				collection: "items",
				locale: "en",
				fields: { rating },
			};
			const predicted = applyTransformations(
				record,
				{ transformations: declared, decisions: { principalMappings: {} } },
				context,
			);
			const decoded = await roundTrip(record.id, { rating });
			expect(decoded.fields.rating, String(rating)).toBe(predicted.fields.rating);
			if (dialect === "postgres") expect(decoded.fields.rating).toBe(Math.fround(rating));
			else expect(decoded.fields.rating).toBe(rating);
		}
	});

	it("round-trips text-held JSON, booleans, and bigints in system tables", async () => {
		const spec = getPortableTableSpec("_emdash_collections")!;
		const collection = await ctx.db
			.selectFrom("_emdash_collections")
			.select(selectExportedColumns(ctx.db, spec.columns))
			.where("slug", "=", "items")
			.executeTakeFirstOrThrow();
		const decoded = decodeRow(ctx.db, spec.columns, collection as Record<string, unknown>);
		expect(decoded).toMatchObject({ slug: "items", hidden: false, routable: true });
		expect(Array.isArray(decoded.supports)).toBe(true);

		const reencoded = encodeRow(ctx.db, spec.columns, decoded);
		expect(reencoded.hidden).toBe(0);
		expect(typeof reencoded.supports).toBe("string");
		expect(decodeRow(ctx.db, spec.columns, reencoded)).toEqual(decoded);

		const staged = await sql<{
			bytes: unknown;
		}>`SELECT CAST(${3_000_000_000} AS bigint) AS bytes`.execute(ctx.db);
		expect(
			decodeRow(
				ctx.db,
				{ bytes: { class: "field", property: "bytes", codec: "integer" } },
				staged.rows[0]!,
			),
		).toEqual({
			bytes: 3_000_000_000,
		});
	});
});
