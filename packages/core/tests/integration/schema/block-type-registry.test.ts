import { afterEach, beforeEach, expect, it } from "vitest";

import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import type { BlockFieldDefinition } from "../../../src/schema/block-types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const heroFields: BlockFieldDefinition[] = [
	{ slug: "heading", label: "Heading", type: "string", required: true },
	{ slug: "image", label: "Image", type: "image", options: { darkVariant: true } },
];

describeEachDialect("BlockTypeRegistry", (dialect) => {
	let ctx: DialectTestContext;
	let registry: BlockTypeRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new BlockTypeRegistry(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates version 1 as active and lists versions in order", async () => {
		const hero = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			description: "Opening section",
			fields: heroFields,
		});

		expect(hero).toMatchObject({
			slug: "hero",
			label: "Hero",
			currentVersion: 1,
			source: "user",
		});
		expect(hero.versions).toHaveLength(1);
		expect(hero.versions[0]).toMatchObject({
			version: 1,
			active: true,
			fields: heroFields,
		});
		expect(hero.versions[0]?.fingerprint).toMatch(/^block-type:v1:sha256:[a-f0-9]{64}$/);
		expect((await registry.listBlockTypes()).map((entry) => entry.slug)).toEqual(["hero"]);
	});

	it("amends compatible changes in place and keeps presentation outside the fingerprint", async () => {
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: heroFields,
		});
		const original = created.versions[0]!;
		const relabelled = heroFields.map((field) => ({ ...field, label: `New ${field.label}` }));

		const presentation = await registry.updateBlockType("hero", {
			expectedFingerprint: original.fingerprint,
			label: "Page hero",
			fields: relabelled,
		});

		expect(presentation.currentVersion).toBe(1);
		expect(presentation.versions).toHaveLength(1);
		expect(presentation.versions[0]?.fingerprint).toBe(original.fingerprint);
		expect(presentation.versions[0]?.fields[0]?.label).toBe("New Heading");

		const additive = await registry.updateBlockType("hero", {
			expectedFingerprint: original.fingerprint,
			fields: [...relabelled, { slug: "eyebrow", label: "Eyebrow", type: "string" }],
		});
		expect(additive.currentVersion).toBe(1);
		expect(additive.versions).toHaveLength(1);
		expect(additive.versions[0]?.fingerprint).not.toBe(original.fingerprint);
	});

	it("requires an explicit breaking update and activation", async () => {
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: heroFields,
		});
		const original = created.versions[0]!;
		const breakingFields = [heroFields[0]!];

		await expect(
			registry.updateBlockType("hero", {
				expectedFingerprint: original.fingerprint,
				fields: breakingFields,
			}),
		).rejects.toMatchObject({
			code: "BLOCK_TYPE_BREAKING_CHANGE",
			details: { differences: expect.any(Array) },
		});

		const versioned = await registry.updateBlockType("hero", {
			expectedFingerprint: original.fingerprint,
			fields: breakingFields,
			breaking: true,
		});
		expect(versioned.currentVersion).toBe(1);
		expect(versioned.versions).toHaveLength(2);
		expect(versioned.versions[0]).toMatchObject({
			version: 1,
			active: true,
			fields: heroFields,
		});
		expect(versioned.versions[1]).toMatchObject({
			version: 2,
			active: false,
			fields: breakingFields,
		});

		const activated = await registry.activateVersion("hero", 2, original.fingerprint);
		expect(activated.currentVersion).toBe(2);
		expect(activated.versions.map((version) => version.active)).toEqual([false, true]);
	});

	it("rejects stale updates and missing activation targets with stable codes", async () => {
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: heroFields,
		});
		const fingerprint = created.versions[0]!.fingerprint;
		const updated = await registry.updateBlockType("hero", {
			expectedFingerprint: fingerprint,
			fields: [...heroFields, { slug: "eyebrow", label: "Eyebrow", type: "string" }],
		});

		await expect(
			registry.updateBlockType("hero", {
				expectedFingerprint: fingerprint,
				label: "Stale",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			registry.activateVersion("hero", 99, updated.versions[0]!.fingerprint),
		).rejects.toMatchObject({ code: "BLOCK_TYPE_VERSION_CONFLICT" });
	});

	it("converges concurrent retries of the same breaking version", async () => {
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: heroFields,
		});
		const input = {
			expectedFingerprint: created.versions[0]!.fingerprint,
			fields: [heroFields[0]!],
			breaking: true,
		} as const;

		const results = await Promise.all([
			registry.updateBlockType("hero", input),
			registry.updateBlockType("hero", input),
		]);

		expect(results[0].versions.map((version) => version.version)).toEqual([1, 2]);
		expect(results[1].versions.map((version) => version.version)).toEqual([1, 2]);
	});

	it("allows only one compatible update from the same fingerprint", async () => {
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: heroFields,
		});
		const fingerprint = created.versions[0]!.fingerprint;

		const results = await Promise.allSettled([
			registry.updateBlockType("hero", {
				expectedFingerprint: fingerprint,
				fields: [...heroFields, { slug: "eyebrow", label: "Eyebrow", type: "string" }],
			}),
			registry.updateBlockType("hero", {
				expectedFingerprint: fingerprint,
				fields: [...heroFields, { slug: "summary", label: "Summary", type: "text" }],
			}),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
	});

	it("preserves unknown stored field types as fail-closed metadata", async () => {
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: heroFields,
		});
		await ctx.db
			.updateTable("_emdash_block_type_versions")
			.set({
				fields: JSON.stringify([{ slug: "layout", label: "Layout", type: "future_nested_type" }]),
			})
			.where("id", "=", created.versions[0]!.id)
			.execute();

		const reread = await registry.getBlockType("hero");
		expect(reread?.versions[0]?.unsupportedTypes).toEqual([
			{ type: "future_nested_type", path: "fields[0].type" },
		]);
		await expect(
			registry.updateBlockType("hero", {
				expectedFingerprint: created.versions[0]!.fingerprint,
				label: "Unsafe edit",
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_FIELD_TYPE" });
	});

	it("returns stable create and lookup errors", async () => {
		await registry.createBlockType({ slug: "hero", label: "Hero", fields: heroFields });
		await expect(
			registry.createBlockType({ slug: "hero", label: "Again", fields: heroFields }),
		).rejects.toMatchObject({ code: "BLOCK_TYPE_EXISTS" });
		await expect(
			registry.updateBlockType("missing", {
				expectedFingerprint: "missing",
				label: "Missing",
			}),
		).rejects.toMatchObject({ code: "BLOCK_TYPE_NOT_FOUND" });
	});

	it("finds affected collections by parsing allowed and retired types in application code", async () => {
		const schema = new SchemaRegistry(ctx.db);
		const pages = await schema.createCollection({ slug: "pages", label: "Pages" });
		const posts = await schema.createCollection({ slug: "posts", label: "Posts" });
		await ctx.db
			.insertInto("_emdash_fields")
			.values([
				{
					id: "layout-field",
					collection_id: pages.id,
					slug: "layout",
					label: "Layout",
					type: "blocks",
					column_type: "JSON",
					required: 0,
					unique: 0,
					default_value: "[]",
					validation: JSON.stringify({ allowedTypes: ["hero"] }),
					widget: null,
					options: null,
					sort_order: 0,
				},
				{
					id: "retired-layout-field",
					collection_id: posts.id,
					slug: "layout",
					label: "Layout",
					type: "blocks",
					column_type: "JSON",
					required: 0,
					unique: 0,
					default_value: "[]",
					validation: JSON.stringify({ retiredTypes: ["hero"] }),
					widget: null,
					options: null,
					sort_order: 0,
				},
			])
			.execute();

		expect(await registry.listAffectedCollections("hero")).toEqual(["pages", "posts"]);
	});
});
