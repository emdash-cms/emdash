import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleShopProductGet, handleShopProductList } from "../../../src/api/handlers/shop.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { ensureShopProductFields } from "../../../src/shop/product-fields.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("shop product presentation fields", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "products", label: "Products" });
		for (const field of [
			{ slug: "name", label: "Name", type: "string" as const },
			{ slug: "price", label: "Price", type: "number" as const },
			{ slug: "stock", label: "Stock", type: "integer" as const },
			{ slug: "availability_status", label: "Availability", type: "string" as const },
		]) {
			await registry.createField("products", field);
		}
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("adds the presentation fields idempotently with the product contract", async () => {
		await ensureShopProductFields(db);
		await ensureShopProductFields(db);

		const fields = await new SchemaRegistry(db).getCollectionWithFields("products");
		expect(fields?.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					slug: "sku",
					type: "string",
					unique: true,
					indexed: true,
					translatable: false,
				}),
				expect.objectContaining({ slug: "short_description", type: "text" }),
				expect.objectContaining({
					slug: "product_details",
					type: "repeater",
					validation: {
						subFields: [{ slug: "text", type: "text", label: "Text", required: true }],
						maxItems: 20,
					},
				}),
			]),
		);
	});

	it("rejects an incompatible existing field without changing it", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createField("products", { slug: "sku", label: "SKU", type: "string" });

		await expect(ensureShopProductFields(db)).rejects.toMatchObject({
			code: "INCOMPATIBLE_FIELD_DEFINITION",
		});
		await expect(registry.getField("products", "sku")).resolves.toMatchObject({
			unique: false,
			indexed: false,
		});
	});

	it("exposes the fields through the public product handlers", async () => {
		await ensureShopProductFields(db);
		await new ContentRepository(db).create({
			type: "products",
			id: "product-1",
			status: "published",
			data: {
				name: "Taza esmaltada Azotea",
				price: 72,
				stock: 4,
				availability_status: "available",
				sku: "AZ-CER-005",
				short_description: "Taza de cerámica esmaltada a mano.",
				product_details: [
					{ text: "Apta para microondas y lavavajillas." },
					{ text: "Capacidad aproximada: 300 ml." },
				],
			},
		});

		const product = await handleShopProductGet(db, "product-1");
		const products = await handleShopProductList(db);
		expect(product).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					data: expect.objectContaining({
						sku: "AZ-CER-005",
						short_description: "Taza de cerámica esmaltada a mano.",
						product_details: [
							{ text: "Apta para microondas y lavavajillas." },
							{ text: "Capacidad aproximada: 300 ml." },
						],
					}),
				}),
			}),
		);
		expect(products).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.arrayContaining([
					expect.objectContaining({ data: expect.objectContaining({ sku: "AZ-CER-005" }) }),
				]),
			}),
		);
	});
});
