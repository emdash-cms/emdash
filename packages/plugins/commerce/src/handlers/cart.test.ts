/**
 * Tests for cart/upsert and cart/get handlers, plus the end-to-end
 * chain: cart/upsert → checkout → payment_pending order.
 */

import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { sha256HexAsync } from "../lib/crypto-adapter.js";
import { inventoryStockDocId } from "../orchestration/finalize-payment.js";
import type { CartGetInput, CartUpsertInput, CheckoutInput } from "../schemas.js";
import type {
	StoredCart,
	StoredIdempotencyKey,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
} from "../types.js";
import { cartGetHandler, cartUpsertHandler } from "./cart.js";
import { checkoutHandler } from "./checkout.js";

// ---------------------------------------------------------------------------
// Shared test infrastructure (mirrors checkout.test.ts pattern)
// ---------------------------------------------------------------------------

class MemColl<T extends object> {
	constructor(public readonly rows = new Map<string, T>()) {}

	async get(id: string): Promise<T | null> {
		const row = this.rows.get(id);
		return row ? structuredClone(row) : null;
	}

	async put(id: string, data: T): Promise<void> {
		this.rows.set(id, structuredClone(data));
	}
}

class MemKv {
	store = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		const row = this.store.get(key);
		return row === undefined ? null : (row as T);
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.store.set(key, value);
	}
}

function upsertCtx(
	input: CartUpsertInput,
	carts: MemColl<StoredCart>,
	kv: MemKv,
): RouteContext<CartUpsertInput> {
	return {
		request: new Request("https://example.test/cart/upsert", { method: "POST" }),
		input,
		storage: { carts },
		requestMeta: { ip: "127.0.0.1" },
		kv,
	} as unknown as RouteContext<CartUpsertInput>;
}

function getCtx(
	input: CartGetInput,
	carts: MemColl<StoredCart>,
): RouteContext<CartGetInput> {
	return {
		request: new Request("https://example.test/cart/get", { method: "POST" }),
		input,
		storage: { carts },
		requestMeta: { ip: "127.0.0.1" },
		kv: new MemKv(),
	} as unknown as RouteContext<CartGetInput>;
}

function checkoutCtx(
	input: CheckoutInput,
	carts: MemColl<StoredCart>,
	orders: MemColl<StoredOrder>,
	paymentAttempts: MemColl<StoredPaymentAttempt>,
	idempotencyKeys: MemColl<StoredIdempotencyKey>,
	inventoryStock: MemColl<StoredInventoryStock>,
	kv: MemKv,
): RouteContext<CheckoutInput> {
	return {
		request: new Request("https://example.test/checkout", {
			method: "POST",
			headers: new Headers({ "Idempotency-Key": input.idempotencyKey ?? "" }),
		}),
		input,
		storage: { carts, orders, paymentAttempts, idempotencyKeys, inventoryStock },
		requestMeta: { ip: "127.0.0.1" },
		kv,
	} as unknown as RouteContext<CheckoutInput>;
}

const LINE = {
	productId: "p1",
	quantity: 1,
	inventoryVersion: 1,
	unitPriceMinor: 1000,
} as const;

// ---------------------------------------------------------------------------
// cart/upsert
// ---------------------------------------------------------------------------

describe("cartUpsertHandler", () => {
	it("creates a cart and returns an ownerToken on first upsert", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const result = await cartUpsertHandler(
			upsertCtx({ cartId: "c1", currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		expect(result.cartId).toBe("c1");
		expect(result.currency).toBe("USD");
		expect(result.lineItemCount).toBe(1);
		expect(result.ownerToken).toBeDefined();
		expect(typeof result.ownerToken).toBe("string");
		expect((result.ownerToken ?? "").length).toBeGreaterThan(0);
		expect(carts.rows.size).toBe(1);
	});

	it("does not return ownerToken on subsequent upserts", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const first = await cartUpsertHandler(
			upsertCtx({ cartId: "c2", currency: "USD", lineItems: [LINE] }, carts, kv),
		);
		const token = first.ownerToken!;

		const second = await cartUpsertHandler(
			upsertCtx(
				{ cartId: "c2", currency: "USD", lineItems: [LINE, { ...LINE, productId: "p2" }], ownerToken: token },
				carts,
				kv,
			),
		);

		expect(second.ownerToken).toBeUndefined();
		expect(second.lineItemCount).toBe(2);
	});

	it("migrates legacy carts and returns a token when one was not provided", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		carts.rows.set("legacy", {
			currency: "USD",
			lineItems: [LINE],
			createdAt: "2026-04-03T12:00:00.000Z",
			updatedAt: "2026-04-03T12:00:00.000Z",
		});

		const result = await cartUpsertHandler(
			upsertCtx(
				{
					cartId: "legacy",
					currency: "USD",
					lineItems: [{ ...LINE, quantity: 2 }],
				},
				carts,
				kv,
			),
		);

		expect(result.ownerToken).toBeDefined();
		const stored = await carts.get("legacy");
		expect(stored!.ownerTokenHash).toBe(await sha256HexAsync(result.ownerToken!));
		expect(stored!.updatedAt).toBeDefined();
	});

	it("accepts a caller-provided token when migrating a legacy cart", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		carts.rows.set("legacy-existing", {
			currency: "USD",
			lineItems: [LINE],
			createdAt: "2026-04-03T12:00:00.000Z",
			updatedAt: "2026-04-03T12:00:00.000Z",
		});

		const ownerToken = "legacy-migration-token-1234567890";
		const result = await cartUpsertHandler(
			upsertCtx(
				{
					cartId: "legacy-existing",
					currency: "USD",
					lineItems: [LINE],
					ownerToken,
				},
				carts,
				kv,
			),
		);

		expect(result.ownerToken).toBeUndefined();
		const stored = await carts.get("legacy-existing");
		expect(stored!.ownerTokenHash).toBe(await sha256HexAsync(ownerToken));
	});

	it("rejects mutation without ownerToken when cart has one", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await cartUpsertHandler(
			upsertCtx({ cartId: "c3", currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		// PluginRouteError stores the wire code (snake_case), not the internal code.
		await expect(
			cartUpsertHandler(
				upsertCtx({ cartId: "c3", currency: "USD", lineItems: [] }, carts, kv),
			),
		).rejects.toMatchObject({ code: "cart_token_required" });
	});

	it("rejects mutation with wrong ownerToken", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await cartUpsertHandler(
			upsertCtx({ cartId: "c4", currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		await expect(
			cartUpsertHandler(
				upsertCtx(
					{ cartId: "c4", currency: "USD", lineItems: [], ownerToken: "a".repeat(48) },
					carts,
					kv,
				),
			),
		).rejects.toMatchObject({ code: "cart_token_invalid" });
	});

	it("preserves createdAt across updates", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const first = await cartUpsertHandler(
			upsertCtx({ cartId: "c5", currency: "USD", lineItems: [LINE] }, carts, kv),
		);
		const storedAfterCreate = await carts.get("c5");
		const createdAt = storedAfterCreate!.createdAt;

		await cartUpsertHandler(
			upsertCtx(
				{ cartId: "c5", currency: "USD", lineItems: [LINE], ownerToken: first.ownerToken },
				carts,
				kv,
			),
		);
		const storedAfterUpdate = await carts.get("c5");

		expect(storedAfterUpdate!.createdAt).toBe(createdAt);
	});

	it("rejects invalid line item quantity", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await expect(
			cartUpsertHandler(
				upsertCtx(
					{ cartId: "c6", currency: "USD", lineItems: [{ ...LINE, quantity: 0 }] },
					carts,
					kv,
				),
			),
		).rejects.toThrow();
	});

	it("rejects negative unit price", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await expect(
			cartUpsertHandler(
				upsertCtx(
					{ cartId: "c7", currency: "USD", lineItems: [{ ...LINE, unitPriceMinor: -1 }] },
					carts,
					kv,
				),
			),
		).rejects.toThrow();
	});

	it("stores ownerTokenHash not the raw token", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const result = await cartUpsertHandler(
			upsertCtx({ cartId: "c8", currency: "USD", lineItems: [LINE] }, carts, kv),
		);
		const stored = await carts.get("c8");
		expect(stored!.ownerTokenHash).toBe(await sha256HexAsync(result.ownerToken!));
		expect(stored!.ownerTokenHash).not.toBe(result.ownerToken);
	});
});

// ---------------------------------------------------------------------------
// cart/get
// ---------------------------------------------------------------------------

describe("cartGetHandler", () => {
	it("returns cart contents for a known cartId when ownerToken matches", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const created = await cartUpsertHandler(
			upsertCtx({ cartId: "g1", currency: "EUR", lineItems: [LINE] }, carts, kv),
		);

		const result = await cartGetHandler(
			getCtx({ cartId: "g1", ownerToken: created.ownerToken }, carts),
		);

		expect(result.cartId).toBe("g1");
		expect(result.currency).toBe("EUR");
		expect(result.lineItems).toHaveLength(1);
		expect(result.lineItems[0]?.productId).toBe("p1");
	});

	it("returns CART_NOT_FOUND for unknown cartId", async () => {
		const carts = new MemColl<StoredCart>();
		// PluginRouteError stores the wire code (snake_case).
		await expect(
			cartGetHandler(getCtx({ cartId: "missing" }, carts)),
		).rejects.toMatchObject({ code: "cart_not_found" });
	});

	it("does not expose ownerTokenHash in the response", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const created = await cartUpsertHandler(
			upsertCtx({ cartId: "g2", currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		const result = await cartGetHandler(
			getCtx({ cartId: "g2", ownerToken: created.ownerToken }, carts),
		);

		expect(result).not.toHaveProperty("ownerTokenHash");
	});

	it("rejects read without ownerToken when cart has ownerTokenHash", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await cartUpsertHandler(
			upsertCtx({ cartId: "g3", currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		await expect(cartGetHandler(getCtx({ cartId: "g3" }, carts))).rejects.toMatchObject({
			code: "cart_token_required",
		});
	});

	it("rejects read with wrong ownerToken", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await cartUpsertHandler(
			upsertCtx({ cartId: "g4", currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		await expect(
			cartGetHandler(getCtx({ cartId: "g4", ownerToken: "b".repeat(32) }, carts)),
		).rejects.toMatchObject({ code: "cart_token_invalid" });
	});

	it("allows read of legacy cart without ownerToken until migrated", async () => {
		const carts = new MemColl<StoredCart>();
		carts.rows.set("legacy-read", {
			currency: "USD",
			lineItems: [LINE],
			createdAt: "2026-04-03T12:00:00.000Z",
			updatedAt: "2026-04-03T12:00:00.000Z",
		});

		const result = await cartGetHandler(getCtx({ cartId: "legacy-read" }, carts));

		expect(result.cartId).toBe("legacy-read");
		expect(result.lineItems).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Integration chain: cart/upsert → checkout → payment_pending
// ---------------------------------------------------------------------------

describe("cart → checkout integration chain", () => {
	it("creates a payment_pending order from a cart upserted via the handler", async () => {
		const cartId = "chain-cart-1";
		const idempotencyKey = "chain-idemp-key-strong-1";
		const now = "2026-04-03T12:00:00.000Z";

		const carts = new MemColl<StoredCart>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();
		const inventoryStock = new MemColl<StoredInventoryStock>(
			new Map([
				[
					inventoryStockDocId("p1", ""),
					{
						productId: "p1",
						variantId: "",
						version: 1,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		);
		const kv = new MemKv();

		// Step 1: upsert cart via handler (no manual storage poke)
		const upsertResult = await cartUpsertHandler(
			upsertCtx({ cartId, currency: "USD", lineItems: [LINE] }, carts, kv),
		);
		expect(upsertResult.ownerToken).toBeDefined();

		// Step 2: checkout against the upserted cart (possession proof matches cart/get/upsert)
		const checkoutResult = await checkoutHandler(
			checkoutCtx(
				{ cartId, idempotencyKey, ownerToken: upsertResult.ownerToken },
				carts,
				orders,
				paymentAttempts,
				idempotencyKeys,
				inventoryStock,
				kv,
			),
		);

		expect(checkoutResult.paymentPhase).toBe("payment_pending");
		expect(checkoutResult.currency).toBe("USD");
		expect(checkoutResult.totalMinor).toBe(1000);
		expect(typeof checkoutResult.orderId).toBe("string");
		expect(typeof checkoutResult.finalizeToken).toBe("string");
		expect(orders.rows.size).toBe(1);
		expect(paymentAttempts.rows.size).toBe(1);
	});

	it("rejects checkout without ownerToken after cart upsert established possession", async () => {
		const cartId = "chain-cart-no-token";
		const idempotencyKey = "chain-idemp-key-no-tok-1";
		const now = "2026-04-03T12:00:00.000Z";

		const carts = new MemColl<StoredCart>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();
		const inventoryStock = new MemColl<StoredInventoryStock>(
			new Map([
				[
					inventoryStockDocId("p1", ""),
					{
						productId: "p1",
						variantId: "",
						version: 1,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		);
		const kv = new MemKv();

		await cartUpsertHandler(
			upsertCtx({ cartId, currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		await expect(
			checkoutHandler(
				checkoutCtx(
					{ cartId, idempotencyKey },
					carts,
					orders,
					paymentAttempts,
					idempotencyKeys,
					inventoryStock,
					kv,
				),
			),
		).rejects.toMatchObject({ code: "cart_token_required" });
	});

	it("checkout is idempotent for the same cart and key", async () => {
		const cartId = "chain-cart-2";
		const idempotencyKey = "chain-idemp-key-strong-2";
		const now = "2026-04-03T12:00:00.000Z";

		const carts = new MemColl<StoredCart>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();
		const inventoryStock = new MemColl<StoredInventoryStock>(
			new Map([
				[
					inventoryStockDocId("p1", ""),
					{
						productId: "p1",
						variantId: "",
						version: 1,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		);
		const kv = new MemKv();

		const upserted = await cartUpsertHandler(
			upsertCtx({ cartId, currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		const ctx = checkoutCtx(
			{ cartId, idempotencyKey, ownerToken: upserted.ownerToken },
			carts,
			orders,
			paymentAttempts,
			idempotencyKeys,
			inventoryStock,
			kv,
		);

		const first = await checkoutHandler(ctx);
		const second = await checkoutHandler(ctx);

		expect(second).toEqual(first);
		expect(orders.rows.size).toBe(1);
		expect(paymentAttempts.rows.size).toBe(1);
	});
});
