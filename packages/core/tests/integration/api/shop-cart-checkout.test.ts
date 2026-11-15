import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleShopCartItemCreate } from "../../../src/api/handlers/shop-cart.js";
import { handleShopOrderCreate } from "../../../src/api/handlers/shop.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("shop cart checkout integration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "products", label: "Products" });
		for (const field of [
			{ slug: "name", label: "Name", type: "string" as const },
			{ slug: "price", label: "Price", type: "number" as const },
			{ slug: "stock", label: "Stock", type: "number" as const },
			{ slug: "availability_status", label: "Availability", type: "string" as const },
		] as const) await registry.createField("products", field);
		await db.insertInto("_emdash_shop_settings").values({ id: "default", store_name: "Shop", currency: "PEN" }).execute();
		await db.insertInto("_emdash_shop_delivery_zones").values({ id: "zone-1", name: "Lima", districts: "[]", delivery_cost: 0 }).execute();
		await new ContentRepository(db).create({ type: "products", id: "product-1", status: "published", data: { name: "Polo", price: 25, stock: 3, availability_status: "available" } });
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("loads persisted cart lines and converts the cart into an order", async () => {
		const cart = await handleShopCartItemCreate(db, {}, { productId: "product-1", quantity: 2 });
		expect(cart.success).toBe(true);
		if (!cart.success || !cart.data.guestToken) return;

		const order = await handleShopOrderCreate(db, {
			items: [],
			cartToken: cart.data.guestToken,
			customer: { firstName: "Ana", lastName: "Torres", phone: "999888777" },
			deliveryZoneId: "zone-1",
			paymentMethod: "whatsapp",
		});

		expect(order.success).toBe(true);
		const storedCart = await db.selectFrom("_emdash_shop_carts").selectAll().executeTakeFirstOrThrow();
		const product = await new ContentRepository(db).findById("products", "product-1");
		expect(storedCart.status).toBe("converted");
		expect(storedCart.converted_order_id).toBe(order.success ? order.data.id : null);
		expect(product?.data.stock).toBe(1);
		const movements = await db
			.selectFrom("_emdash_shop_inventory_movements")
			.selectAll()
			.where("order_id", "=", order.success ? order.data.id : "missing")
			.execute();
		expect(movements).toHaveLength(1);
		expect(movements[0]?.type).toBe("sale");
		expect(movements[0]?.quantity_delta).toBe(-2);
	});

	it("rejects insufficient stock and keeps the cart active", async () => {
		const cart = await handleShopCartItemCreate(db, {}, { productId: "product-1", quantity: 2 });
		expect(cart.success && cart.data.guestToken).toBeTruthy();
		if (!cart.success || !cart.data.guestToken) return;
		await sql`UPDATE ${sql.ref("ec_products")} SET stock = ${1}, version = version + 1 WHERE id = ${"product-1"}`.execute(db);

		const order = await handleShopOrderCreate(db, {
			items: [],
			cartToken: cart.data.guestToken,
			customer: { firstName: "Ana", lastName: "Torres", phone: "999888777" },
			deliveryZoneId: "zone-1",
			paymentMethod: "whatsapp",
		});
		const storedCart = await db.selectFrom("_emdash_shop_carts").select("status").executeTakeFirstOrThrow();
		expect(order.success).toBe(false);
		expect(storedCart.status).toBe("active");
	});

	it("rejects an expired cart before creating an order", async () => {
		const cart = await handleShopCartItemCreate(db, {}, { productId: "product-1", quantity: 1 });
		expect(cart.success && cart.data.guestToken).toBeTruthy();
		if (!cart.success || !cart.data.guestToken) return;
		await db.updateTable("_emdash_shop_carts").set({ expires_at: "2000-01-01T00:00:00.000Z" }).where("id", "=", cart.data.id).execute();

		const order = await handleShopOrderCreate(db, {
			items: [],
			cartToken: cart.data.guestToken,
			customer: { firstName: "Ana", lastName: "Torres", phone: "999888777" },
			deliveryZoneId: "zone-1",
			paymentMethod: "whatsapp",
		});
		expect(order.success).toBe(false);
		if (!order.success) expect(order.error.code).toBe("SHOP_CART_NOT_FOUND");
	});

	it("does not allow a converted cart to be checked out twice", async () => {
		const cart = await handleShopCartItemCreate(db, {}, { productId: "product-1", quantity: 1 });
		expect(cart.success && cart.data.guestToken).toBeTruthy();
		if (!cart.success || !cart.data.guestToken) return;
		const input = {
			items: [],
			cartToken: cart.data.guestToken,
			customer: { firstName: "Ana", lastName: "Torres", phone: "999888777" },
			deliveryZoneId: "zone-1",
			paymentMethod: "whatsapp",
		};
		const first = await handleShopOrderCreate(db, input);
		const second = await handleShopOrderCreate(db, input);
		expect(first.success).toBe(true);
		expect(second.success).toBe(false);
		if (!second.success) expect(second.error.code).toBe("SHOP_CART_NOT_FOUND");
	});
});
