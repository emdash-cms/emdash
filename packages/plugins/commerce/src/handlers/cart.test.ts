/**
 * Tests for cart/upsert and cart/get handlers, plus the end-to-end
 * chain: cart/upsert → checkout → payment_pending order.
 */

import type { RouteContext } from "emdash";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { sha256HexAsync } from "../lib/crypto-adapter.js";
import { inventoryStockDocId } from "../orchestration/finalize-payment.js";
import type { CartGetInput, CartUpsertInput, CheckoutInput } from "../schemas.js";
import type {
	StoredBundleComponent,
	StoredCart,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredIdempotencyKey,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductSku,
	StoredProductSkuOptionValue,
} from "../types.js";
import { cartGetHandler, cartUpsertHandler } from "./cart.js";
import { checkoutHandler } from "./checkout.js";

const consumeKvRateLimit = vi.fn(async (_opts?: unknown) => true);
vi.mock("../lib/rate-limit-kv.js", () => ({
	__esModule: true,
	consumeKvRateLimit: (opts: unknown) => consumeKvRateLimit(opts),
}));

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

function decodeStockDocId(id: string): { productId: string; variantId: string } | null {
	const prefix = "stock:";
	if (!id.startsWith(prefix)) return null;
	const rest = id.slice(prefix.length);
	const idx = rest.indexOf(":");
	if (idx === -1) return null;
	return {
		productId: decodeURIComponent(rest.slice(0, idx)),
		variantId: decodeURIComponent(rest.slice(idx + 1)),
	};
}

/**
 * Serves generous default stock for any `stock:product:variant` id so cart upsert
 * tests do not need per-SKU seed rows.
 */
class PermissiveInventoryStockColl {
	constructor(public readonly rows = new Map<string, StoredInventoryStock>()) {}

	async get(id: string): Promise<StoredInventoryStock | null> {
		const row = this.rows.get(id);
		if (row) return structuredClone(row);
		const parsed = decodeStockDocId(id);
		if (!parsed) return null;
		return {
			productId: parsed.productId,
			variantId: parsed.variantId,
			version: 1,
			quantity: 50_000,
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
	}

	async put(id: string, data: StoredInventoryStock): Promise<void> {
		this.rows.set(id, structuredClone(data));
	}
}

class DefaultProductsColl extends MemColl<StoredProduct> {
	override async get(id: string): Promise<StoredProduct | null> {
		const row = this.rows.get(id);
		if (row) return structuredClone(row);
		const ts = "2026-01-01T00:00:00.000Z";
		return {
			id,
			type: "simple",
			status: "active",
			visibility: "public",
			slug: id,
			title: id,
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: ts,
			updatedAt: ts,
		};
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

type CartGetInputForTest = Omit<CartGetInput, "ownerToken"> & { ownerToken?: string };
type CheckoutInputForTest = Omit<CheckoutInput, "ownerToken"> & { ownerToken?: string };

function asRouteContext<T>(context: unknown): RouteContext<T> {
	return context as RouteContext<T>;
}

function upsertCtx(
	input: CartUpsertInput,
	carts: MemColl<StoredCart>,
	kv: MemKv,
): RouteContext<CartUpsertInput> {
	return asRouteContext<CartUpsertInput>({
		request: new Request("https://example.test/cart/upsert", { method: "POST" }),
		input,
		storage: {
			carts,
			products: new DefaultProductsColl(),
			bundleComponents: new MemColl<StoredBundleComponent>(),
			productSkus: new MemColl<StoredProductSku>(),
			inventoryStock: new PermissiveInventoryStockColl(),
		},
		requestMeta: { ip: "127.0.0.1" },
		kv,
	});
}

function getCtx(
	input: CartGetInputForTest,
	carts: MemColl<StoredCart>,
): RouteContext<CartGetInput> {
	return asRouteContext<CartGetInput>({
		request: new Request("https://example.test/cart/get", { method: "POST" }),
		input: {
			cartId: input.cartId,
			...(input.ownerToken !== undefined ? { ownerToken: input.ownerToken } : {}),
		},
		storage: { carts },
		requestMeta: { ip: "127.0.0.1" },
		kv: new MemKv(),
	});
}

function checkoutCtx(
	input: CheckoutInputForTest,
	carts: MemColl<StoredCart>,
	orders: MemColl<StoredOrder>,
	paymentAttempts: MemColl<StoredPaymentAttempt>,
	idempotencyKeys: MemColl<StoredIdempotencyKey>,
	inventoryStock: MemColl<StoredInventoryStock>,
	kv: MemKv,
): RouteContext<CheckoutInput> {
	return asRouteContext<CheckoutInput>({
		request: new Request("https://example.test/checkout", {
			method: "POST",
			headers: new Headers({ "Idempotency-Key": input.idempotencyKey ?? "" }),
		}),
		input: {
			cartId: input.cartId,
			idempotencyKey: input.idempotencyKey,
			...(input.ownerToken !== undefined ? { ownerToken: input.ownerToken } : {}),
		},
		storage: {
			carts,
			orders,
			paymentAttempts,
			idempotencyKeys,
			inventoryStock,
			products: new DefaultProductsColl(),
			bundleComponents: new MemColl<StoredBundleComponent>(),
			productSkus: new MemColl<StoredProductSku>(),
			productSkuOptionValues: new MemColl<StoredProductSkuOptionValue>(),
			digitalAssets: new MemColl<StoredDigitalAsset>(),
			digitalEntitlements: new MemColl<StoredDigitalEntitlement>(),
			productAssetLinks: new MemColl<StoredProductAssetLink>(),
			productAssets: new MemColl<StoredProductAsset>(),
		},
		requestMeta: { ip: "127.0.0.1" },
		kv,
	});
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
	beforeEach(() => {
		consumeKvRateLimit.mockResolvedValue(true);
	});

	it("requires POST method", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const ctx = {
			request: new Request("https://example.test/cart/upsert", { method: "GET" }),
			input: { cartId: "c_method", currency: "USD", lineItems: [LINE] },
			storage: { carts },
			requestMeta: { ip: "127.0.0.1" },
			kv,
		} as unknown as RouteContext<CartUpsertInput>;
		await expect(cartUpsertHandler(ctx)).rejects.toMatchObject({ code: "METHOD_NOT_ALLOWED" });
	});

	it("enforces cart line item cap", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		const tooMany = Array.from({ length: COMMERCE_LIMITS.maxCartLineItems + 1 }, (_, i) => ({
			...LINE,
			productId: `p-${i}`,
		}));
		await expect(
			cartUpsertHandler(
				upsertCtx({ cartId: "c_caps", currency: "USD", lineItems: tooMany }, carts, kv),
			),
		).rejects.toMatchObject({ code: "payload_too_large" });
	});

	it("rate-limits cart mutation bursts", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		consumeKvRateLimit.mockResolvedValueOnce(false);

		await expect(
			cartUpsertHandler(
				upsertCtx({ cartId: "c_rate", currency: "USD", lineItems: [LINE] }, carts, kv),
			),
		).rejects.toMatchObject({ code: "rate_limited" });
	});

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
				{
					cartId: "c2",
					currency: "USD",
					lineItems: [LINE, { ...LINE, productId: "p2" }],
					ownerToken: token,
				},
				carts,
				kv,
			),
		);

		expect(second.ownerToken).toBeUndefined();
		expect(second.lineItemCount).toBe(2);
	});

	it("rejects mutation without ownerToken when cart has one", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await cartUpsertHandler(
			upsertCtx({ cartId: "c3", currency: "USD", lineItems: [LINE] }, carts, kv),
		);

		// PluginRouteError stores the wire code (snake_case), not the internal code.
		await expect(
			cartUpsertHandler(upsertCtx({ cartId: "c3", currency: "USD", lineItems: [] }, carts, kv)),
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
	beforeEach(() => {
		consumeKvRateLimit.mockResolvedValue(true);
	});

	it("requires POST method", async () => {
		const carts = new MemColl<StoredCart>();
		const kv = new MemKv();
		await carts.put("g_method", {
			currency: "USD",
			lineItems: [LINE],
			ownerTokenHash: "owner-hash-method",
			createdAt: "2026-04-03T12:00:00.000Z",
			updatedAt: "2026-04-03T12:00:00.000Z",
		});
		const ctx = {
			request: new Request("https://example.test/cart/get", { method: "GET" }),
			input: { cartId: "g_method" },
			storage: { carts },
			requestMeta: { ip: "127.0.0.1" },
			kv,
		} as unknown as RouteContext<CartGetInput>;
		await expect(cartGetHandler(ctx)).rejects.toMatchObject({ code: "METHOD_NOT_ALLOWED" });
	});

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
		await expect(cartGetHandler(getCtx({ cartId: "missing" }, carts))).rejects.toMatchObject({
			code: "cart_not_found",
		});
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

		await cartUpsertHandler(upsertCtx({ cartId, currency: "USD", lineItems: [LINE] }, carts, kv));

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
