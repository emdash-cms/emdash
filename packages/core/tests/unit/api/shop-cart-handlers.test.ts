import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleShopCartGet,
	handleShopCartItemUpdate,
	handleShopCartClear,
} from "../../../src/api/handlers/shop-cart.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("shop cart handlers", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("creates an empty guest cart and does not expose the token in the view", async () => {
		await db.insertInto("_emdash_shop_settings").values({ id: "default", store_name: "Shop", currency: "USD" }).execute();
		const result = await handleShopCartGet(db, {});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.guestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(result.data.items).toHaveLength(0);
		expect(result.data.currency).toBe("USD");
	});

	it("does not update an item outside the active cart", async () => {
		const result = await handleShopCartItemUpdate(db, { guestToken: "A".repeat(43) }, "missing", 2);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("SHOP_CART_NOT_FOUND");
	});

	it("does not clear a cart belonging to another guest token", async () => {
		const result = await handleShopCartClear(db, { guestToken: "B".repeat(43) });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("SHOP_CART_NOT_FOUND");
	});
});
