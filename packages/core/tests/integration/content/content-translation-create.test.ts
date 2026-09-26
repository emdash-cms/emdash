import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const LONG_COLLECTION_SLUG = `t${"o".repeat(38)}`;

describeEachDialect("content translation create", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		ctx = await setupForDialectWithCollections(dialect);
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("returns a stable conflict when two creates target the same group and locale", async () => {
		const source = await runtime.handleContentCreate("post", {
			data: { title: "Hello" },
			locale: "en",
		});
		if (!source.success) throw new Error(source.error.message);

		const results = await Promise.all([
			runtime.handleContentCreate("post", {
				data: { title: "Bonjour A" },
				locale: "fr",
				translationOf: source.data.item.id,
			}),
			runtime.handleContentCreate("post", {
				data: { title: "Bonjour B" },
				locale: "fr",
				translationOf: source.data.item.id,
			}),
		]);

		expect(results.filter((result) => result.success)).toHaveLength(1);
		const conflict = results.find((result) => !result.success);
		expect(conflict).toMatchObject({
			success: false,
			error: {
				code: "CONFLICT",
				message: 'Translation already exists in locale "fr" for this content item',
			},
		});
	});

	it("rejects missing, cross-collection, and unconfigured translation sources", async () => {
		const otherCollection = await runtime.handleContentCreate("page", {
			data: { title: "Other" },
			locale: "en",
		});
		if (!otherCollection.success) throw new Error(otherCollection.error.message);

		for (const translationOf of ["missing", otherCollection.data.item.id]) {
			await expect(
				runtime.handleContentCreate("post", {
					data: { title: "Bonjour" },
					locale: "fr",
					translationOf,
				}),
			).resolves.toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
		}

		await expect(
			runtime.handleContentCreate("post", {
				data: { title: "Hola" },
				locale: "es",
			}),
		).resolves.toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("returns a conflict when restoring a replaced locale", async () => {
		const source = await runtime.handleContentCreate("post", {
			data: { title: "Hello" },
			locale: "en",
		});
		if (!source.success) throw new Error(source.error.message);
		const original = await runtime.handleContentCreate("post", {
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: source.data.item.id,
		});
		if (!original.success) throw new Error(original.error.message);
		await runtime.handleContentDelete("post", original.data.item.id);
		const replacement = await runtime.handleContentCreate("post", {
			data: { title: "Bonjour again" },
			locale: "fr",
			translationOf: source.data.item.id,
		});
		expect(replacement.success).toBe(true);

		await expect(
			runtime.handleContentRestore("post", original.data.item.id),
		).resolves.toMatchObject({
			success: false,
			error: { code: "CONFLICT", message: "An active translation already exists in this locale" },
		});
	});

	it("returns a conflict when restoring a replaced locale in a long-named collection", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: LONG_COLLECTION_SLUG,
			label: "Long collection",
			labelSingular: "Long collection",
		});
		await registry.createField(LONG_COLLECTION_SLUG, {
			slug: "title",
			label: "Title",
			type: "string",
		});

		const source = await runtime.handleContentCreate(LONG_COLLECTION_SLUG, {
			data: { title: "Hello" },
			locale: "en",
		});
		if (!source.success) throw new Error(source.error.message);
		const original = await runtime.handleContentCreate(LONG_COLLECTION_SLUG, {
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: source.data.item.id,
		});
		if (!original.success) throw new Error(original.error.message);
		await runtime.handleContentDelete(LONG_COLLECTION_SLUG, original.data.item.id);
		const replacement = await runtime.handleContentCreate(LONG_COLLECTION_SLUG, {
			data: { title: "Bonjour again" },
			locale: "fr",
			translationOf: source.data.item.id,
		});
		expect(replacement.success).toBe(true);

		await expect(
			runtime.handleContentRestore(LONG_COLLECTION_SLUG, original.data.item.id),
		).resolves.toMatchObject({
			success: false,
			error: { code: "CONFLICT", message: "An active translation already exists in this locale" },
		});
	});

	it("treats locale casing as one identity without configured i18n", async () => {
		setI18nConfig(null);
		const source = await runtime.handleContentCreate("post", {
			data: { title: "Hello" },
			locale: "en",
		});
		if (!source.success) throw new Error(source.error.message);
		const first = await runtime.handleContentCreate("post", {
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: source.data.item.id,
		});
		expect(first.success).toBe(true);

		await expect(
			runtime.handleContentCreate("post", {
				data: { title: "Bonjour again" },
				locale: "FR",
				translationOf: source.data.item.id,
			}),
		).resolves.toMatchObject({ success: false, error: { code: "CONFLICT" } });
	});

	it("accepts configured custom locale paths", async () => {
		setI18nConfig({ defaultLocale: "english", locales: ["english", "french"] });
		const source = await runtime.handleContentCreate("post", {
			data: { title: "Hello" },
			locale: "english",
		});
		if (!source.success) throw new Error(source.error.message);

		await expect(
			runtime.handleContentCreate("post", {
				data: { title: "Bonjour" },
				locale: "french",
				translationOf: source.data.item.id,
			}),
		).resolves.toMatchObject({
			success: true,
			data: { item: { locale: "french", translationGroup: source.data.item.translationGroup } },
		});
	});

	it("does not create a translation when the source is trashed during save hooks", async () => {
		const source = await runtime.handleContentCreate("post", {
			data: { title: "Hello" },
			locale: "en",
		});
		if (!source.success) throw new Error(source.error.message);
		let trashSource = true;
		runtime = createTestRuntime(ctx.db, {
			plugins: [
				definePlugin({
					id: "trash-source",
					version: "1.0.0",
					capabilities: ["content:write"],
					hooks: {
						"content:beforeSave": async (event) => {
							if (trashSource) {
								trashSource = false;
								await new ContentRepository(ctx.db).delete("post", source.data.item.id);
							}
							return event.content;
						},
					},
				}),
			],
		});

		await expect(
			runtime.handleContentCreate("post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: source.data.item.id,
			}),
		).resolves.toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
	});

	it("reads shared fields atomically with the translation insert", async () => {
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "sku",
			label: "SKU",
			type: "string",
			translatable: false,
		});
		const source = await runtime.handleContentCreate("post", {
			data: { title: "Hello", sku: "SKU-1" },
			locale: "en",
		});
		if (!source.success) throw new Error(source.error.message);
		let updateSource = true;
		runtime = createTestRuntime(ctx.db, {
			plugins: [
				definePlugin({
					id: "update-source",
					version: "1.0.0",
					capabilities: ["content:write"],
					hooks: {
						"content:beforeSave": async (event) => {
							if (updateSource) {
								updateSource = false;
								await new ContentRepository(ctx.db).update("post", source.data.item.id, {
									data: { sku: "SKU-2" },
								});
							}
							return event.content;
						},
					},
				}),
			],
		});

		const translated = await runtime.handleContentCreate("post", {
			data: { title: "Bonjour", sku: "STALE" },
			locale: "fr",
			translationOf: source.data.item.id,
		});
		expect(translated).toMatchObject({ success: true, data: { item: { data: { sku: "SKU-2" } } } });
	});
});
