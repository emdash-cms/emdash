import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type Result<T> = { success: true; data: T } | { success: false; error: { message: string } };

function ok<T>(result: Result<T>): T {
	if (!result.success) throw new Error(result.error.message);
	return result.data;
}

describeEachDialect("non-translatable field sync", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "de"] });
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		for (const [slug, supports] of [
			["posts", undefined],
			["pages", []],
		] as const) {
			await registry.createCollection({
				slug,
				label: slug,
				...(supports ? { supports: [...supports] } : {}),
			});
			await registry.createField(slug, { slug: "title", label: "Title", type: "string" });
			await registry.createField(slug, {
				slug: "sku",
				label: "SKU",
				type: "string",
				translatable: false,
			});
		}
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	async function createPair(collection: "posts" | "pages", sku = "SKU-1") {
		const en = ok(
			await runtime.handleContentCreate(collection, {
				data: { title: "Hello", sku },
				slug: "hello",
				locale: "en",
			}),
		);
		const de = ok(
			await runtime.handleContentCreate(collection, {
				data: { title: "Hallo", sku },
				slug: "hallo",
				locale: "de",
				translationOf: en.item.id,
			}),
		);
		return { enId: en.item.id, deId: de.item.id };
	}

	async function read(collection: "posts" | "pages", id: string, locale: string) {
		return ok(await runtime.handleContentGet(collection, id, locale));
	}

	async function saveAndPublish(id: string, locale: string, data: Record<string, unknown>) {
		ok(await runtime.handleContentUpdate("posts", id, { data, locale }));
		ok(await runtime.handleContentPublish("posts", id));
	}

	async function publishWithoutSync(id: string) {
		await new ContentRepository(ctx.db).publish("posts", id);
	}

	describe("on a collection with revisions", () => {
		async function createPublishedPair() {
			const pair = await createPair("posts");
			ok(await runtime.handleContentPublish("posts", pair.enId));
			ok(await runtime.handleContentPublish("posts", pair.deId));
			return pair;
		}

		it("copies a published value to the other locales", async () => {
			const { enId, deId } = await createPublishedPair();

			await saveAndPublish(deId, "de", { sku: "SKU-2" });

			expect((await read("posts", deId, "de")).item.data.sku).toBe("SKU-2");
			expect((await read("posts", enId, "en")).item.data.sku).toBe("SKU-2");
		});

		it("leaves the other locales alone until the change is published", async () => {
			const { enId, deId } = await createPublishedPair();
			const before = await read("posts", enId, "en");

			ok(
				await runtime.handleContentUpdate("posts", deId, { data: { sku: "SKU-2" }, locale: "de" }),
			);

			const after = await read("posts", enId, "en");
			expect(after.item.data.sku).toBe("SKU-1");
			expect(after._rev).toBe(before._rev);
		});

		it("clears the value in the other locales when a cleared value is published", async () => {
			const { enId, deId } = await createPublishedPair();

			await saveAndPublish(deId, "de", { sku: null });

			expect((await read("posts", enId, "en")).item.data.sku).toBeUndefined();
		});

		it("keeps the synced value when another locale is republished or unpublished", async () => {
			const { enId, deId } = await createPublishedPair();
			await saveAndPublish(deId, "de", { sku: "SKU-2" });

			ok(await runtime.handleContentPublish("posts", enId));
			expect((await read("posts", enId, "en")).item.data.sku).toBe("SKU-2");

			ok(await runtime.handleContentUnpublish("posts", enId));
			expect((await read("posts", enId, "en")).item.data.sku).toBe("SKU-2");

			ok(await runtime.handleContentPublish("posts", enId));
			expect((await read("posts", enId, "en")).item.data.sku).toBe("SKU-2");
			expect((await read("posts", deId, "de")).item.data.sku).toBe("SKU-2");
		});

		it("carries the value into a pending draft that left the field alone", async () => {
			const { enId, deId } = await createPublishedPair();
			ok(
				await runtime.handleContentUpdate("posts", enId, {
					data: { title: "Hello again" },
					locale: "en",
				}),
			);

			await saveAndPublish(deId, "de", { sku: "SKU-2" });

			const draft = await read("posts", enId, "en");
			expect(draft.item.data).toMatchObject({ title: "Hello again", sku: "SKU-2" });

			ok(await runtime.handleContentPublish("posts", enId));
			expect((await read("posts", enId, "en")).item.data).toMatchObject({
				title: "Hello again",
				sku: "SKU-2",
			});
			expect((await read("posts", deId, "de")).item.data.sku).toBe("SKU-2");
		});

		it("keeps a value that a pending draft changed on its own", async () => {
			const { enId, deId } = await createPublishedPair();
			ok(
				await runtime.handleContentUpdate("posts", enId, { data: { sku: "SKU-3" }, locale: "en" }),
			);

			await saveAndPublish(deId, "de", { sku: "SKU-2" });

			expect((await read("posts", enId, "en")).item.data.sku).toBe("SKU-3");

			ok(await runtime.handleContentPublish("posts", enId));
			expect((await read("posts", enId, "en")).item.data.sku).toBe("SKU-3");
			expect((await read("posts", deId, "de")).item.data.sku).toBe("SKU-3");
		});

		it("does not touch a locale that already holds the published value", async () => {
			const { enId, deId } = await createPublishedPair();
			ok(
				await runtime.handleContentUpdate("posts", deId, { data: { sku: "SKU-2" }, locale: "de" }),
			);
			await publishWithoutSync(deId);
			const before = await read("posts", deId, "de");

			await saveAndPublish(enId, "en", { sku: "SKU-2" });

			const after = await read("posts", deId, "de");
			expect(after._rev).toBe(before._rev);
			expect(after.item.updatedAt).toBe(before.item.updatedAt);
		});

		it("keeps the other locales' value when a translation without it is published", async () => {
			const en = ok(
				await runtime.handleContentCreate("posts", {
					data: { title: "Hello", sku: "SKU-1" },
					slug: "hello",
					locale: "en",
				}),
			);
			ok(await runtime.handleContentPublish("posts", en.item.id));
			const de = ok(
				await runtime.handleContentCreate("posts", {
					data: { title: "Hallo" },
					slug: "hallo",
					locale: "de",
					translationOf: en.item.id,
				}),
			);

			ok(await runtime.handleContentPublish("posts", de.item.id));

			expect((await read("posts", en.item.id, "en")).item.data.sku).toBe("SKU-1");
		});

		it("does not copy a value the publication left unchanged", async () => {
			const { enId, deId } = await createPublishedPair();
			ok(
				await runtime.handleContentUpdate("posts", enId, { data: { sku: "SKU-2" }, locale: "en" }),
			);
			await publishWithoutSync(enId);

			await saveAndPublish(deId, "de", { title: "Hallo again" });

			expect((await read("posts", enId, "en")).item.data.sku).toBe("SKU-2");
		});
	});

	describe("on a collection without revisions", () => {
		it("advances the other locale's _rev when a sync rewrites its data", async () => {
			const { enId, deId } = await createPair("pages");
			const before = await read("pages", enId, "en");

			ok(
				await runtime.handleContentUpdate("pages", deId, { data: { sku: "SKU-2" }, locale: "de" }),
			);

			const after = await read("pages", enId, "en");
			expect(after.item.data.sku).toBe("SKU-2");
			expect(after._rev).not.toBe(before._rev);
		});

		it("refuses a write carrying the pre-sync _rev instead of losing the synced value", async () => {
			const { enId, deId } = await createPair("pages");
			const staleRev = (await read("pages", enId, "en"))._rev;

			ok(
				await runtime.handleContentUpdate("pages", deId, { data: { sku: "SKU-2" }, locale: "de" }),
			);

			const stale = await runtime.handleContentUpdate("pages", enId, {
				data: { title: "Hello again", sku: "SKU-1" },
				locale: "en",
				_rev: staleRev,
			});
			expect(stale.success).toBe(false);
			expect(stale.success ? undefined : stale.error.code).toBe("CONFLICT");
			expect((await read("pages", enId, "en")).item.data.sku).toBe("SKU-2");
		});
	});
});
