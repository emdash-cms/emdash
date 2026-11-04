import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("blocks field schema", (dialect) => {
	let ctx: DialectTestContext;
	let schema: SchemaRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		schema = new SchemaRegistry(ctx.db);
		const blocks = new BlockTypeRegistry(ctx.db);
		await blocks.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: [{ slug: "heading", label: "Heading", type: "string", required: true }],
		});
		await blocks.createBlockType({
			slug: "call_to_action",
			label: "Call to action",
			fields: [{ slug: "label", label: "Label", type: "string", required: true }],
		});
		await schema.createCollection({ slug: "pages", label: "Pages" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("adds a non-null JSON column whose existing and new rows read as an empty array", async () => {
		const repo = new ContentRepository(ctx.db);
		const existing = await repo.create({ type: "pages", slug: "existing", data: {} });

		const field = await schema.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero"], maxItems: 20 },
		});
		const created = await repo.create({ type: "pages", slug: "new", data: {} });

		expect(field).toMatchObject({
			type: "blocks",
			columnType: "JSON",
			required: false,
			validation: {
				allowedTypes: ["hero"],
				retiredTypes: [],
				minItems: 0,
				maxItems: 20,
			},
		});
		expect((await repo.findById("pages", existing.id))?.data.layout).toEqual([]);
		expect((await repo.findById("pages", created.id))?.data.layout).toEqual([]);
	});

	it("keeps removed allowed types retired and restores them when re-enabled", async () => {
		await schema.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero", "call_to_action"] },
		});

		const retired = await schema.updateField("pages", "layout", {
			validation: { allowedTypes: ["hero"], retiredTypes: [] },
		});
		expect(retired.validation?.retiredTypes).toEqual(["call_to_action"]);

		const restored = await schema.updateField("pages", "layout", {
			validation: { allowedTypes: ["hero", "call_to_action"], retiredTypes: [] },
		});
		expect(restored.validation?.retiredTypes).toEqual([]);
	});

	it("rejects column-oriented options and invalid limits", async () => {
		for (const [index, input] of [
			{ required: true },
			{ unique: true },
			{ indexed: true },
			{ searchable: true },
			{ widget: "custom" },
			{ defaultValue: [{ _type: "hero" }] },
		].entries()) {
			await expect(
				schema.createField("pages", {
					slug: `layout_${index}`,
					label: "Layout",
					type: "blocks",
					validation: { allowedTypes: ["hero"] },
					...input,
				}),
			).rejects.toMatchObject({
				code: expect.stringMatching(/VALIDATION_ERROR|FIELD_NOT_INDEXABLE/),
			});
		}
		await expect(
			schema.createField("pages", {
				slug: "layout_too_large",
				label: "Layout",
				type: "blocks",
				validation: { allowedTypes: ["hero"], maxItems: 101 },
			}),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
		await expect(
			schema.createField("pages", {
				slug: "layout_missing",
				label: "Layout",
				type: "blocks",
				validation: { allowedTypes: ["missing"] },
			}),
		).rejects.toMatchObject({ code: "BLOCK_TYPE_NOT_FOUND" });
	});

	it("requires a migration before introducing a positive minimum on populated content", async () => {
		const repo = new ContentRepository(ctx.db);
		await repo.create({ type: "pages", slug: "existing", data: {} });

		await expect(
			schema.createField("pages", {
				slug: "layout",
				label: "Layout",
				type: "blocks",
				validation: { allowedTypes: ["hero"], minItems: 1 },
			}),
		).rejects.toMatchObject({ code: "FIELD_UPDATE_REQUIRES_MIGRATION" });
	});
});
