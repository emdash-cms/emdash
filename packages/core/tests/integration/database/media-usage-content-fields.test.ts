import { afterEach, beforeEach, expect, it } from "vitest";

import { IdentifierError } from "../../../src/database/validate.js";
import {
	loadContentMediaUsageFields,
	MediaUsageFieldDiscoveryError,
} from "../../../src/media/usage/content-fields.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content media usage field discovery", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("discovers V1 extraction fields and display fields separately", async () => {
		await registry.createField("posts", { slug: "name", label: "Name", type: "string" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "raw_data", label: "Raw Data", type: "json" });
		await registry.createField("posts", { slug: "attachment", label: "Attachment", type: "file" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", {
			slug: "sections",
			label: "Sections",
			type: "repeater",
			validation: {
				subFields: [
					{ slug: "caption", type: "text", label: "Caption" },
					{ slug: "image", type: "image", label: "Image" },
				],
			},
		});

		const discovery = await loadContentMediaUsageFields(ctx.db, "posts");

		expect(discovery.displayFieldSlugs).toEqual(["title", "name"]);
		expect(discovery.extractionFields).toEqual([
			{ slug: "attachment", type: "file" },
			{ slug: "body", type: "portableText" },
			{ slug: "hero", type: "image" },
			{
				slug: "sections",
				type: "repeater",
				validation: { subFields: [{ slug: "image", type: "image" }] },
			},
		]);
	});

	it("filters unsupported repeater subfields and excludes repeaters without images", async () => {
		await registry.createField("posts", {
			slug: "sections",
			label: "Sections",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		});
		await registry.createField("posts", {
			slug: "downloads",
			label: "Downloads",
			type: "repeater",
			validation: { subFields: [{ slug: "placeholder", type: "image", label: "Placeholder" }] },
		});

		await ctx.db
			.updateTable("_emdash_fields")
			.set({
				validation: JSON.stringify({
					subFields: [
						{ slug: "download", type: "file", label: "Download" },
						{ slug: "image", type: "image", label: "Image" },
						{ slug: "caption", type: "text", label: "Caption" },
					],
				}),
			})
			.where("slug", "=", "sections")
			.execute();
		await ctx.db
			.updateTable("_emdash_fields")
			.set({
				validation: JSON.stringify({
					subFields: [{ slug: "download", type: "file", label: "Download" }],
				}),
			})
			.where("slug", "=", "downloads")
			.execute();

		const discovery = await loadContentMediaUsageFields(ctx.db, "posts");

		expect(discovery.extractionFields).toEqual([
			{
				slug: "sections",
				type: "repeater",
				validation: { subFields: [{ slug: "image", type: "image" }] },
			},
		]);
	});

	it("fails closed on malformed repeater validation", async () => {
		await registry.createField("posts", {
			slug: "sections",
			label: "Sections",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		});
		await ctx.db
			.updateTable("_emdash_fields")
			.set({ validation: "{" })
			.where("slug", "=", "sections")
			.execute();

		await expect(loadContentMediaUsageFields(ctx.db, "posts")).rejects.toThrow(
			MediaUsageFieldDiscoveryError,
		);
	});

	it("rejects supported fields with invalid slugs before they can become column refs", async () => {
		const collection = await registry.getCollection("posts");
		expect(collection).not.toBeNull();

		await ctx.db
			.insertInto("_emdash_fields")
			.values({
				id: "invalid-media-field",
				collection_id: collection!.id,
				slug: "bad-slug",
				label: "Bad Slug",
				type: "image",
				column_type: "TEXT",
				required: 0,
				unique: 0,
				default_value: null,
				validation: null,
				widget: null,
				options: null,
				sort_order: 0,
			})
			.execute();

		await expect(loadContentMediaUsageFields(ctx.db, "posts")).rejects.toThrow(IdentifierError);
	});
});
