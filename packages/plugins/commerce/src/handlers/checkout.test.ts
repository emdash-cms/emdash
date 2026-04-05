import type { RouteContext } from "emdash";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { sha256HexAsync } from "../lib/crypto-adapter.js";
import { cartContentFingerprint } from "../lib/cart-fingerprint.js";
import { inventoryStockDocId } from "../orchestration/finalize-payment.js";
import type { CheckoutInput } from "../schemas.js";
import type {
	StoredCart,
	StoredIdempotencyKey,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredBundleComponent,
	StoredProductSku,
	StoredProductSkuOptionValue,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
} from "../types.js";
import { checkoutHandler } from "./checkout.js";
import {
	CHECKOUT_ROUTE,
	deterministicOrderId,
	deterministicPaymentAttemptId,
} from "./checkout-state.js";

const consumeKvRateLimit = vi.fn(async (_opts?: unknown) => true);
vi.mock("../lib/rate-limit-kv.js", () => ({
	__esModule: true,
	consumeKvRateLimit: (opts: unknown) => consumeKvRateLimit(opts),
}));

type MemCollection<T extends object> = {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	query?(options?: { where?: Record<string, unknown>; limit?: number }): Promise<{
		items: Array<{ id: string; data: T }>;
		hasMore: boolean;
	}>;
	rows: Map<string, T>;
};

class MemColl<T extends object> implements MemCollection<T> {
	constructor(public readonly rows = new Map<string, T>()) {}

	async get(id: string): Promise<T | null> {
		const row = this.rows.get(id);
		return row ? structuredClone(row) : null;
	}

	async put(id: string, data: T): Promise<void> {
		this.rows.set(id, structuredClone(data));
	}

	async query(
		options: { where?: Record<string, unknown>; limit?: number } = {},
	): Promise<{ items: Array<{ id: string; data: T }>; hasMore: boolean }> {
		const where = options.where ?? {};
		const limit = options.limit;
		let items = Array.from(this.rows.entries(), ([id, data]) => ({ id, data }));
		for (const [field, value] of Object.entries(where)) {
			items = items.filter((item) => (item.data as Record<string, unknown>)[field] === value);
		}
		if (typeof limit === "number") {
			items = items.slice(0, limit);
		}
		return { items, hasMore: false };
	}
}

/** Default catalog product for checkout tests that do not seed `products`. */
class DefaultProductsColl extends MemColl<StoredProduct> {
	async get(id: string): Promise<StoredProduct | null> {
		const row = this.rows.get(id);
		if (row) return structuredClone(row);
		const now = "2026-01-01T00:00:00.000Z";
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
			createdAt: now,
			updatedAt: now,
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

function oneTimePutFailure<T extends object>(
	collection: MemColl<T>,
	failCallNumber = 2,
): MemColl<T> {
	let callCount = 0;
	return {
		get rows() {
			return collection.rows;
		},
		get: (id: string) => collection.get(id),
		put: async (id: string, data: T): Promise<void> => {
			callCount += 1;
			if (callCount === failCallNumber) {
				throw new Error("simulated idempotency persistence failure");
			}
			await collection.put(id, data);
		},
	} as MemColl<T>;
}

function contextFor({
	idempotencyKeys,
	orders,
	paymentAttempts,
	carts,
	inventoryStock,
	kv,
	idempotencyKey,
	cartId,
	ownerToken,
	requestMethod = "POST",
	ip = "127.0.0.1",
	extras,
}: {
	idempotencyKeys: MemCollection<StoredIdempotencyKey>;
	orders: MemCollection<StoredOrder>;
	paymentAttempts: MemCollection<StoredPaymentAttempt>;
	carts: MemCollection<StoredCart>;
	inventoryStock: MemCollection<StoredInventoryStock>;
	kv: MemKv;
	idempotencyKey: string;
	cartId: string;
	ownerToken?: string;
	requestMethod?: string;
	ip?: string;
	extras?: {
		products?: MemCollection<StoredProduct>;
		productSkus?: MemCollection<StoredProductSku>;
		productSkuOptionValues?: MemCollection<StoredProductSkuOptionValue>;
		digitalAssets?: MemCollection<StoredDigitalAsset>;
		digitalEntitlements?: MemCollection<StoredDigitalEntitlement>;
		productAssetLinks?: MemCollection<StoredProductAssetLink>;
		productAssets?: MemCollection<StoredProductAsset>;
		bundleComponents?: MemCollection<StoredBundleComponent>;
	};
}): RouteContext<CheckoutInput> {
	const req = new Request("https://example.local/checkout", {
		method: requestMethod,
		headers: new Headers({ "Idempotency-Key": idempotencyKey }),
	});
	const catalogDefaults = {
		products: new DefaultProductsColl(),
		productSkus: new MemColl<StoredProductSku>(),
		productSkuOptionValues: new MemColl<StoredProductSkuOptionValue>(),
		digitalAssets: new MemColl<StoredDigitalAsset>(),
		digitalEntitlements: new MemColl<StoredDigitalEntitlement>(),
		productAssetLinks: new MemColl<StoredProductAssetLink>(),
		productAssets: new MemColl<StoredProductAsset>(),
		bundleComponents: new MemColl<StoredBundleComponent>(),
	};
	return {
		request: req as Request & { headers: Headers },
		input: {
			cartId,
			idempotencyKey,
			...(ownerToken !== undefined ? { ownerToken } : {}),
		},
		storage: {
			idempotencyKeys,
			orders,
			paymentAttempts,
			carts,
			inventoryStock,
			...catalogDefaults,
			...extras,
		},
		requestMeta: {
			ip,
		},
		kv,
	} as unknown as RouteContext<CheckoutInput>;
}

describe("checkout idempotency persistence recovery", () => {
	it("retries without duplicate orders when idempotency persistence fails after partial success", async () => {
		const cartId = "cart_1";
		const idempotencyKey = "idem-key-strong-16";
		const now = "2026-04-02T12:00:00.000Z";
	const ownerToken = "owner-token-for-idempotent-retry";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: "p1",
					quantity: 1,
					inventoryVersion: 3,
					unitPriceMinor: 500,
				},
			],
		ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const idempotencyRows = new Map<string, StoredIdempotencyKey>();
		const idempotencyBase = new MemColl(idempotencyRows);
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const carts = new MemColl(new Map([[cartId, cart]]));
		const inventoryStock = new MemColl(
			new Map([
				[
					inventoryStockDocId("p1", ""),
					{
						productId: "p1",
						variantId: "",
						version: 3,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		);
		const kv = new MemKv();

		// Pending 202 then completed 200 — fail the second idempotency write after order/attempt exist.
		const failingIdempotency = oneTimePutFailure(idempotencyBase, 2);
		const failingCtx = contextFor({
			idempotencyKeys: failingIdempotency,
			orders,
			paymentAttempts,
			carts,
			inventoryStock,
			kv,
			idempotencyKey,
			cartId,
			ownerToken,
		});

		await expect(checkoutHandler(failingCtx)).rejects.toThrow(
			"simulated idempotency persistence failure",
		);

		expect(orders.rows.size).toBe(1);
		expect(paymentAttempts.rows.size).toBe(1);
		const firstOrderId = orders.rows.keys().next().value;
		const firstAttemptId = paymentAttempts.rows.keys().next().value;

		const retryCtx = contextFor({
			idempotencyKeys: idempotencyBase,
			orders,
			paymentAttempts,
			carts,
			inventoryStock,
			kv,
			idempotencyKey,
			cartId,
			ownerToken,
		});
		const secondResult = await checkoutHandler(retryCtx);

		expect(secondResult).toMatchObject({
			orderId: firstOrderId,
			paymentAttemptId: firstAttemptId,
			currency: "USD",
			paymentPhase: "payment_pending",
		});
		expect(orders.rows.size).toBe(1);
		expect(paymentAttempts.rows.size).toBe(1);
	});

	it("falls back to storage-backed checkout when cached completed response has no matching rows", async () => {
		const cartId = "cart_stale_cache";
		const idempotencyKey = "idem-key-stale-cache";
		const now = "2026-04-02T12:00:00.000Z";
		const ownerToken = "owner-token-for-stale-cache";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: "p1",
					quantity: 1,
					inventoryVersion: 2,
					unitPriceMinor: 650,
				},
			],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const carts = new MemColl(new Map([[cartId, cart]]));
		const inventoryStock = new MemColl(
			new Map([
				[
					inventoryStockDocId("p1", ""),
					{
						productId: "p1",
						variantId: "",
						version: 2,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		);
		const kv = new MemKv();
		const idempotencyRows = new Map<string, StoredIdempotencyKey>();
		const idempotency = new MemColl(idempotencyRows);

		const fingerprint = cartContentFingerprint(cart.lineItems);
		const keyHash = await sha256HexAsync(
			`${CHECKOUT_ROUTE}|${cartId}|${cart.updatedAt}|${fingerprint}|${idempotencyKey}`,
		);
		const idempotencyDocId = `idemp:${keyHash}`;
		await idempotency.put(idempotencyDocId, {
			route: CHECKOUT_ROUTE,
			keyHash,
			httpStatus: 200,
			responseBody: {
				orderId: "stale_order_1",
				paymentPhase: "payment_pending",
				paymentAttemptId: "stale_attempt_1",
				currency: "USD",
				totalMinor: 650,
				finalizeToken: "cached-token",
			},
			createdAt: now,
		});

		const result = await checkoutHandler(
			contextFor({
				idempotencyKeys: idempotency,
				orders,
				paymentAttempts,
				carts,
				inventoryStock,
				kv,
				idempotencyKey,
				cartId,
				ownerToken,
			}),
		);

		const expectedOrderId = deterministicOrderId(keyHash);
		const expectedAttemptId = deterministicPaymentAttemptId(keyHash);
		expect(result.orderId).toBe(expectedOrderId);
		expect(result.paymentAttemptId).toBe(expectedAttemptId);
		expect(orders.rows.size).toBe(1);
		expect(paymentAttempts.rows.size).toBe(1);
		expect(orders.rows.has(expectedOrderId)).toBe(true);
		expect(paymentAttempts.rows.has(expectedAttemptId)).toBe(true);
	});

	it("serves fresh idempotent replay on repeated successful checkout calls", async () => {
		const cartId = "cart_2";
		const idempotencyKey = "idem-key-strong-2";
		const now = "2026-04-02T12:00:00.000Z";
	const ownerToken = "owner-token-for-idempotent-replay";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: "p2",
					quantity: 2,
					inventoryVersion: 1,
					unitPriceMinor: 200,
				},
			],
		ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const idempotency = new MemColl<StoredIdempotencyKey>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const carts = new MemColl(new Map([[cartId, cart]]));
		const inventoryStock = new MemColl(
			new Map([
				[
					inventoryStockDocId("p2", ""),
					{
						productId: "p2",
						variantId: "",
						version: 1,
						quantity: 5,
						updatedAt: now,
					},
				],
			]),
		);
		const kv = new MemKv();
		const baseCtx = contextFor({
			idempotencyKeys: idempotency,
			orders,
			paymentAttempts,
			carts,
			inventoryStock,
			kv,
			idempotencyKey,
			cartId,
			ownerToken,
		});

		const first = await checkoutHandler(baseCtx);
		const second = await checkoutHandler(baseCtx);

		expect(second).toEqual(first);
		expect(orders.rows.size).toBe(1);
		expect(paymentAttempts.rows.size).toBe(1);
	});

	it("requires ownerToken when cart has ownerTokenHash", async () => {
		const cartId = "cart_owned";
		const idempotencyKey = "idem-key-owned-16ch";
		const now = "2026-04-02T12:00:00.000Z";
		const ownerSecret = "owner-secret-for-checkout-1";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 }],
			ownerTokenHash: await sha256HexAsync(ownerSecret),
			createdAt: now,
			updatedAt: now,
		};

		const ctx = contextFor({
			idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
			orders: new MemColl<StoredOrder>(),
			paymentAttempts: new MemColl<StoredPaymentAttempt>(),
			carts: new MemColl(new Map([[cartId, cart]])),
			inventoryStock: new MemColl(
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
			),
			kv: new MemKv(),
			idempotencyKey,
			cartId,
		});

		await expect(checkoutHandler(ctx)).rejects.toMatchObject({ code: "cart_token_required" });
	});

	it("completes checkout when ownerToken matches cart ownerTokenHash", async () => {
		const cartId = "cart_owned_ok";
		const idempotencyKey = "idem-key-owned-ok16";
		const now = "2026-04-02T12:00:00.000Z";
		const ownerSecret = "correct-owner-token-12345";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 }],
			ownerTokenHash: await sha256HexAsync(ownerSecret),
			createdAt: now,
			updatedAt: now,
		};

		const ctx = contextFor({
			idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
			orders: new MemColl<StoredOrder>(),
			paymentAttempts: new MemColl<StoredPaymentAttempt>(),
			carts: new MemColl(new Map([[cartId, cart]])),
			inventoryStock: new MemColl(
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
			),
			kv: new MemKv(),
			idempotencyKey,
			cartId,
			ownerToken: ownerSecret,
		});

		const out = await checkoutHandler(ctx);
		expect(out.paymentPhase).toBe("payment_pending");
		expect(out.totalMinor).toBe(100);
	});

	it("rejects checkout with wrong ownerToken when cart has ownerTokenHash", async () => {
		const cartId = "cart_owned_2";
		const idempotencyKey = "idem-key-owned-16c2";
		const now = "2026-04-02T12:00:00.000Z";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 }],
			ownerTokenHash: await sha256HexAsync("correct-owner-token-12345"),
			createdAt: now,
			updatedAt: now,
		};

		const ctx = contextFor({
			idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
			orders: new MemColl<StoredOrder>(),
			paymentAttempts: new MemColl<StoredPaymentAttempt>(),
			carts: new MemColl(new Map([[cartId, cart]])),
			inventoryStock: new MemColl(
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
			),
			kv: new MemKv(),
			idempotencyKey,
			cartId,
			ownerToken: "wrong-owner-token-123456789012",
		});

		await expect(checkoutHandler(ctx)).rejects.toMatchObject({ code: "cart_token_invalid" });
	});

});

describe("checkout route guardrails", () => {
	beforeEach(() => {
		consumeKvRateLimit.mockClear();
		consumeKvRateLimit.mockResolvedValue(true);
	});

	it("requires POST method", async () => {
		const cartId = "cart_method";
		const now = "2026-04-02T12:00:00.000Z";
		const ownerToken = "owner-token-method-123456";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 }],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const ctx = contextFor({
			idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
			orders: new MemColl<StoredOrder>(),
			paymentAttempts: new MemColl<StoredPaymentAttempt>(),
			carts: new MemColl(new Map([[cartId, cart]])),
			inventoryStock: new MemColl(),
			kv: new MemKv(),
			idempotencyKey: "idem-key-strong-16",
			cartId,
			requestMethod: "GET",
			ownerToken,
		});
		await expect(checkoutHandler(ctx)).rejects.toMatchObject({ code: "METHOD_NOT_ALLOWED" });
	});

	it("validates cart content bounds before processing", async () => {
		const cartId = "cart_caps";
		const now = "2026-04-02T12:00:00.000Z";
		const ownerToken = "owner-token-bounds";
		const tooMany = Array.from({ length: COMMERCE_LIMITS.maxCartLineItems + 1 }, (_, i) => ({
			productId: `p-${i}`,
			quantity: 1,
			inventoryVersion: 1,
			unitPriceMinor: 100,
		}));

		const ctx = contextFor({
			idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
			orders: new MemColl<StoredOrder>(),
			paymentAttempts: new MemColl<StoredPaymentAttempt>(),
			carts: new MemColl(
				new Map([
					[
						cartId,
						{
							currency: "USD",
							lineItems: tooMany,
						ownerTokenHash: await sha256HexAsync(ownerToken),
							createdAt: now,
							updatedAt: now,
						},
					],
				]),
			),
			inventoryStock: new MemColl(),
			kv: new MemKv(),
			idempotencyKey: "idem-key-strong-17",
			cartId,
			ownerToken,
		});
		await expect(checkoutHandler(ctx)).rejects.toMatchObject({ code: "payload_too_large" });
	});

	it("blocks checkout when rate limit is exceeded", async () => {
		const cartId = "cart_rate";
		const now = "2026-04-02T12:00:00.000Z";
		const ownerToken = "owner-token-rate-limit";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 }],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};
		const idempotencyKey = "idem-key-strong-r8";

		const ctx = contextFor({
			idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
			orders: new MemColl<StoredOrder>(),
			paymentAttempts: new MemColl<StoredPaymentAttempt>(),
			carts: new MemColl(new Map([[cartId, cart]])),
			inventoryStock: new MemColl(),
			kv: new MemKv(),
			idempotencyKey,
			cartId,
			ownerToken,
		});

		consumeKvRateLimit.mockResolvedValueOnce(false);
		await expect(checkoutHandler(ctx)).rejects.toMatchObject({ code: "rate_limited" });
		expect(consumeKvRateLimit).toHaveBeenCalledTimes(1);
	});

	it("rejects mismatched header/body idempotency input", async () => {
		const cartId = "cart_conflict";
		const now = "2026-04-02T12:00:00.000Z";
		const ownerToken = "owner-token-conflict";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 }],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};
		const req = new Request("https://example.local/checkout", {
			method: "POST",
			headers: new Headers({ "Idempotency-Key": "header-key-16chars" }),
		});
		const ctx = {
			request: req as Request & { headers: Headers },
			input: {
				cartId,
				idempotencyKey: "body-key-16chars",
			},
			storage: {
				idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
				orders: new MemColl<StoredOrder>(),
				paymentAttempts: new MemColl<StoredPaymentAttempt>(),
				carts: new MemColl(new Map([[cartId, cart]])),
				inventoryStock: new MemColl(),
			},
			requestMeta: { ip: "127.0.0.1" },
			kv: new MemKv(),
		} as unknown as RouteContext<CheckoutInput>;
		await expect(checkoutHandler(ctx)).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("checkout order snapshot capture", () => {
	it("stores catalog snapshot fields on order line items", async () => {
		const now = "2026-04-04T12:00:00.000Z";
		const cartId = "snapshot-cart";
		const idempotencyKey = "idem-key-snapshot-16";
		const ownerToken = "owner-token-snapshot";

		const product: StoredProduct = {
			id: "product_snapshot_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "snapshot-product",
			title: "Snapshot Product",
			shortDescription: "Snap short",
			longDescription: "Snap long",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const sku: StoredProductSku = {
			id: "sku_snapshot_1",
			productId: product.id,
			skuCode: "SNAP-SKU",
			status: "active",
			unitPriceMinor: 1200,
			compareAtPriceMinor: 1500,
			inventoryQuantity: 20,
			inventoryVersion: 4,
			requiresShipping: true,
			isDigital: false,
			createdAt: now,
			updatedAt: now,
		};
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: product.id,
					variantId: sku.id,
					quantity: 2,
					inventoryVersion: 4,
					unitPriceMinor: 1200,
				},
			],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const carts = new MemColl(new Map([[cartId, cart]]));
		const inventoryStock = new MemColl(
			new Map([
				[
					inventoryStockDocId(product.id, sku.id),
					{
						productId: product.id,
						variantId: sku.id,
						version: 4,
						quantity: 5,
						updatedAt: now,
					},
				],
			]),
		);
		const products = new MemColl(new Map([[product.id, product]]));
		const productSkus = new MemColl(new Map([[sku.id, sku]]));

		const out = await checkoutHandler(
			contextFor({
				idempotencyKeys,
				orders,
				paymentAttempts,
				carts,
				inventoryStock,
				kv: new MemKv(),
				idempotencyKey,
				cartId,
				ownerToken,
				extras: {
					products,
					productSkus,
					productSkuOptionValues: new MemColl(),
					digitalAssets: new MemColl(),
					digitalEntitlements: new MemColl(),
					productAssetLinks: new MemColl(),
					productAssets: new MemColl(),
					bundleComponents: new MemColl(),
				},
			}),
		);

		expect(out.totalMinor).toBe(2400);
		const orderId = deterministicOrderId(
			await sha256HexAsync(
				`${CHECKOUT_ROUTE}|${cartId}|${cart.updatedAt}|${cartContentFingerprint(cart.lineItems)}|${idempotencyKey}`,
			),
		);
		const order = await orders.get(orderId);
		expect(order).toBeTruthy();
		expect(order?.lineItems[0]?.snapshot?.productTitle).toBe("Snapshot Product");
		expect(order?.lineItems[0]?.snapshot?.skuCode).toBe("SNAP-SKU");
		expect(order?.lineItems[0]?.snapshot?.lineSubtotalMinor).toBe(2400);
		expect(order?.lineItems[0]?.snapshot?.lineDiscountMinor).toBe(0);
		expect(order?.lineItems[0]?.snapshot?.lineTotalMinor).toBe(2400);

		product.title = "Updated Title";
		sku.unitPriceMinor = 3000;
		await products.put(product.id, product);
		await productSkus.put(sku.id, sku);

		const cachedOrder = await orders.get(orderId);
		expect(cachedOrder?.lineItems[0]?.snapshot?.productTitle).toBe("Snapshot Product");
	});

	it("captures digital entitlement and image snapshot data", async () => {
		const now = "2026-04-04T12:00:00.000Z";
		const cartId = "snapshot-digital-cart";
		const idempotencyKey = "idem-digital-16chars";
		const ownerToken = "owner-token-digital";

		const product: StoredProduct = {
			id: "product_digital_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "snapshot-digital",
			title: "Snapshot Digital",
			shortDescription: "Snapshot digital short",
			longDescription: "Snapshot digital long",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: false,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const sku: StoredProductSku = {
			id: "sku_digital_1",
			productId: product.id,
			skuCode: "DIGI-SKU",
			status: "active",
			unitPriceMinor: 900,
			compareAtPriceMinor: 1200,
			inventoryQuantity: 30,
			inventoryVersion: 2,
			requiresShipping: false,
			isDigital: true,
			createdAt: now,
			updatedAt: now,
		};
		const image: StoredProductAsset = {
			id: "asset_image_1",
			provider: "cloudinary",
			externalAssetId: "image-001",
			fileName: "snapshot.jpg",
			altText: "Snapshot cover",
			createdAt: now,
			updatedAt: now,
		};
		const imageLink: StoredProductAssetLink = {
			id: "asset_link_image_1",
			targetType: "product",
			targetId: product.id,
			assetId: image.id,
			role: "primary_image",
			position: 0,
			createdAt: now,
			updatedAt: now,
		};
		const asset: StoredDigitalAsset = {
			id: "digital_asset_1",
			provider: "s3",
			externalAssetId: "asset-pdf",
			label: "Guide PDF",
			downloadLimit: 2,
			downloadExpiryDays: 60,
			isManualOnly: false,
			isPrivate: false,
			createdAt: now,
			updatedAt: now,
		};
		const entitlement: StoredDigitalEntitlement = {
			id: "entitlement_1",
			skuId: sku.id,
			digitalAssetId: asset.id,
			grantedQuantity: 1,
			createdAt: now,
			updatedAt: now,
		};
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: product.id,
					variantId: sku.id,
					quantity: 1,
					inventoryVersion: 2,
					unitPriceMinor: 900,
				},
			],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const carts = new MemColl(new Map([[cartId, cart]]));
		const inventoryStock = new MemColl(
			new Map([
				[
					inventoryStockDocId(product.id, sku.id),
					{
						productId: product.id,
						variantId: sku.id,
						version: 2,
						quantity: 20,
						updatedAt: now,
					},
				],
			]),
		);
		const products = new MemColl(new Map([[product.id, product]]));
		const productSkus = new MemColl(new Map([[sku.id, sku]]));
		const productAssets = new MemColl(new Map([[image.id, image]]));
		const productAssetLinks = new MemColl(new Map([[imageLink.id, imageLink]]));
		const digitalAssets = new MemColl(new Map([[asset.id, asset]]));
		const digitalEntitlements = new MemColl(new Map([[entitlement.id, entitlement]]));

		await checkoutHandler(
			contextFor({
				idempotencyKeys,
				orders,
				paymentAttempts,
				carts,
				inventoryStock,
				kv: new MemKv(),
				idempotencyKey,
				cartId,
				ownerToken,
				extras: {
					products,
					productSkus,
					productSkuOptionValues: new MemColl(),
					digitalAssets,
					digitalEntitlements,
					productAssetLinks,
					productAssets,
					bundleComponents: new MemColl(),
				},
			}),
		);

		const orderId = deterministicOrderId(
			await sha256HexAsync(
				`${CHECKOUT_ROUTE}|${cartId}|${cart.updatedAt}|${cartContentFingerprint(cart.lineItems)}|${idempotencyKey}`,
			),
		);
		const order = await orders.get(orderId);
		const snapshot = order?.lineItems[0]?.snapshot;
		expect(snapshot?.digitalEntitlements).toEqual([
			{
				entitlementId: entitlement.id,
				digitalAssetId: asset.id,
				digitalAssetLabel: asset.label,
				grantedQuantity: entitlement.grantedQuantity,
				downloadLimit: asset.downloadLimit,
				downloadExpiryDays: asset.downloadExpiryDays,
				isManualOnly: asset.isManualOnly,
				isPrivate: asset.isPrivate,
			},
		]);
		expect(snapshot?.image).toMatchObject({
			assetId: image.id,
			provider: image.provider,
			externalAssetId: image.externalAssetId,
		});
	});

	it("persists frozen snapshot during idempotent checkout replay", async () => {
		const now = "2026-04-05T12:00:00.000Z";
		const cartId = "snapshot-replay-cart";
		const idempotencyKey = "idem-key-replay-16";
		const ownerToken = "owner-token-replay";

		const product: StoredProduct = {
			id: "product_replay_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "snapshot-replay",
			title: "Replay Product",
			shortDescription: "Replay short",
			longDescription: "Replay long",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const sku: StoredProductSku = {
			id: "sku_replay_1",
			productId: product.id,
			skuCode: "REPLAY-SKU",
			status: "active",
			unitPriceMinor: 1500,
			inventoryQuantity: 12,
			inventoryVersion: 1,
			requiresShipping: true,
			isDigital: false,
			createdAt: now,
			updatedAt: now,
		};
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: product.id,
					variantId: sku.id,
					quantity: 1,
					inventoryVersion: 1,
					unitPriceMinor: 1500,
				},
			],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const carts = new MemColl(new Map([[cartId, cart]]));
		const inventoryStock = new MemColl(
			new Map([
				[
					inventoryStockDocId(product.id, sku.id),
					{
						productId: product.id,
						variantId: sku.id,
						version: 1,
						quantity: 6,
						updatedAt: now,
					},
				],
			]),
		);
		const ctx = contextFor({
			idempotencyKeys,
			orders,
			paymentAttempts,
			carts,
			inventoryStock,
			kv: new MemKv(),
			idempotencyKey,
			cartId,
			ownerToken,
			extras: {
				products: new MemColl(new Map([[product.id, product]])),
				productSkus: new MemColl(new Map([[sku.id, sku]])),
				productSkuOptionValues: new MemColl(),
				digitalAssets: new MemColl(),
				digitalEntitlements: new MemColl(),
				productAssetLinks: new MemColl(),
				productAssets: new MemColl(),
				bundleComponents: new MemColl(),
			},
		});

		const first = await checkoutHandler(ctx);
		product.title = "Mutated Replay Product";
		sku.unitPriceMinor = 9999;
		await (ctx.storage.products as MemColl<StoredProduct>).put(product.id, product);
		await (ctx.storage.productSkus as MemColl<StoredProductSku>).put(sku.id, sku);
		const second = await checkoutHandler(ctx);
		expect(second.orderId).toBe(first.orderId);

		const orderId = deterministicOrderId(
			await sha256HexAsync(
				`${CHECKOUT_ROUTE}|${cartId}|${cart.updatedAt}|${cartContentFingerprint(cart.lineItems)}|${idempotencyKey}`,
			),
		);
		const order = await orders.get(orderId);
		expect(order?.lineItems[0]?.snapshot?.productTitle).toBe("Replay Product");
		expect(second.totalMinor).toBe(first.totalMinor);
	});

	it("captures bundle summary in snapshot", async () => {
		const now = "2026-04-06T12:00:00.000Z";
		const cartId = "snapshot-bundle-cart";
		const idempotencyKey = "idem-key-bundle-16";
		const ownerToken = "owner-token-bundle";

		const componentProductA: StoredProduct = {
			id: "bundle_component_product_a",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "component-a",
			title: "Component A",
			shortDescription: "Component A short",
			longDescription: "Component A long",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const componentProductB: StoredProduct = {
			id: "bundle_component_product_b",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "component-b",
			title: "Component B",
			shortDescription: "Component B short",
			longDescription: "Component B long",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const bundle: StoredProduct = {
			id: "bundle_product_1",
			type: "bundle",
			status: "active",
			visibility: "public",
			slug: "snapshot-bundle",
			title: "Snapshot Bundle",
			shortDescription: "Bundle short",
			longDescription: "Bundle long",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			bundleDiscountType: "percentage",
			bundleDiscountValueBps: 10_000,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const componentSkuA: StoredProductSku = {
			id: "bundle_component_sku_a",
			productId: componentProductA.id,
			skuCode: "COMP-A",
			status: "active",
			unitPriceMinor: 1000,
			inventoryQuantity: 20,
			inventoryVersion: 1,
			requiresShipping: true,
			isDigital: false,
			createdAt: now,
			updatedAt: now,
		};
		const componentSkuB: StoredProductSku = {
			id: "bundle_component_sku_b",
			productId: componentProductB.id,
			skuCode: "COMP-B",
			status: "active",
			unitPriceMinor: 500,
			inventoryQuantity: 9,
			inventoryVersion: 1,
			requiresShipping: true,
			isDigital: false,
			createdAt: now,
			updatedAt: now,
		};
		const componentA: StoredBundleComponent = {
			id: "bundle_comp_link_a",
			bundleProductId: bundle.id,
			componentSkuId: componentSkuA.id,
			quantity: 2,
			position: 0,
			createdAt: now,
			updatedAt: now,
		};
		const componentB: StoredBundleComponent = {
			id: "bundle_comp_link_b",
			bundleProductId: bundle.id,
			componentSkuId: componentSkuB.id,
			quantity: 1,
			position: 1,
			createdAt: now,
			updatedAt: now,
		};

		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: bundle.id,
					quantity: 2,
					inventoryVersion: 1,
					unitPriceMinor: 0,
				},
			],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();
		const orders = new MemColl<StoredOrder>();
		const paymentAttempts = new MemColl<StoredPaymentAttempt>();
		const carts = new MemColl(new Map([[cartId, cart]]));
		const inventoryStock = new MemColl(
			new Map([
				[
					inventoryStockDocId(componentProductA.id, componentSkuA.id),
					{
						productId: componentProductA.id,
						variantId: componentSkuA.id,
						version: 5,
						quantity: 50,
						updatedAt: now,
					},
				],
				[
					inventoryStockDocId(componentProductB.id, componentSkuB.id),
					{
						productId: componentProductB.id,
						variantId: componentSkuB.id,
						version: 7,
						quantity: 30,
						updatedAt: now,
					},
				],
			]),
		);
		const products = new MemColl(
			new Map([
				[componentProductA.id, componentProductA],
				[componentProductB.id, componentProductB],
				[bundle.id, bundle],
			]),
		);
		const productSkus = new MemColl(
			new Map([
				[componentSkuA.id, componentSkuA],
				[componentSkuB.id, componentSkuB],
			]),
		);
		const bundleComponents = new MemColl(
			new Map([
				[componentA.id, componentA],
				[componentB.id, componentB],
			]),
		);

		await checkoutHandler(
			contextFor({
				idempotencyKeys,
				orders,
				paymentAttempts,
				carts,
				inventoryStock,
				kv: new MemKv(),
				idempotencyKey,
				cartId,
				ownerToken,
				extras: {
					products,
					productSkus,
					productSkuOptionValues: new MemColl(),
					digitalAssets: new MemColl(),
					digitalEntitlements: new MemColl(),
					productAssetLinks: new MemColl(),
					productAssets: new MemColl(),
					bundleComponents,
				},
			}),
		);

		const orderId = deterministicOrderId(
			await sha256HexAsync(
				`${CHECKOUT_ROUTE}|${cartId}|${cart.updatedAt}|${cartContentFingerprint(cart.lineItems)}|${idempotencyKey}`,
			),
		);
		const order = await orders.get(orderId);
		const snapshot = order?.lineItems[0]?.snapshot;
		expect(snapshot?.bundleSummary).toMatchObject({
			subtotalMinor: 2500,
			discountType: "percentage",
			discountValueBps: 10_000,
			discountAmountMinor: 2500,
			finalPriceMinor: 0,
			availability: 9,
		});
		expect(snapshot?.lineSubtotalMinor).toBe(5000);
		expect(snapshot?.lineDiscountMinor).toBe(5000);
		expect(snapshot?.lineTotalMinor).toBe(0);
		expect(order?.lineItems[0]?.unitPriceMinor).toBe(0);
		expect(snapshot?.bundleSummary?.components.every((c) => c.componentInventoryVersion >= 0)).toBe(
			true,
		);
	});

	it("rejects checkout when a bundle component has insufficient stock", async () => {
		const now = "2026-04-07T12:00:00.000Z";
		const cartId = "snapshot-bundle-low-stock";
		const idempotencyKey = "idem-bundle-lowstk16";
		const ownerToken = "owner-token-bndl-low";

		const componentProduct: StoredProduct = {
			id: "low_stock_comp_prod",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "low-comp",
			title: "Component",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const bundle: StoredProduct = {
			id: "bundle_low_stock",
			type: "bundle",
			status: "active",
			visibility: "public",
			slug: "bundle-low",
			title: "Low bundle",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			bundleDiscountType: "none",
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		};
		const componentSku: StoredProductSku = {
			id: "low_stock_comp_sku",
			productId: componentProduct.id,
			skuCode: "LOW-COMP",
			status: "active",
			unitPriceMinor: 100,
			inventoryQuantity: 5,
			inventoryVersion: 1,
			requiresShipping: true,
			isDigital: false,
			createdAt: now,
			updatedAt: now,
		};
		const componentLink: StoredBundleComponent = {
			id: "low_bc_1",
			bundleProductId: bundle.id,
			componentSkuId: componentSku.id,
			quantity: 10,
			position: 0,
			createdAt: now,
			updatedAt: now,
		};
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{
					productId: bundle.id,
					quantity: 1,
					inventoryVersion: 1,
					unitPriceMinor: 100,
				},
			],
			ownerTokenHash: await sha256HexAsync(ownerToken),
			createdAt: now,
			updatedAt: now,
		};

		await expect(
			checkoutHandler(
				contextFor({
					idempotencyKeys: new MemColl<StoredIdempotencyKey>(),
					orders: new MemColl<StoredOrder>(),
					paymentAttempts: new MemColl<StoredPaymentAttempt>(),
					carts: new MemColl(new Map([[cartId, cart]])),
					inventoryStock: new MemColl(
						new Map([
							[
								inventoryStockDocId(componentProduct.id, componentSku.id),
								{
									productId: componentProduct.id,
									variantId: componentSku.id,
									version: 1,
									quantity: 3,
									updatedAt: now,
								},
							],
						]),
					),
					kv: new MemKv(),
					idempotencyKey,
					cartId,
					ownerToken,
					extras: {
						products: new MemColl(
							new Map([
								[componentProduct.id, componentProduct],
								[bundle.id, bundle],
							]),
						),
						productSkus: new MemColl(new Map([[componentSku.id, componentSku]])),
						productSkuOptionValues: new MemColl(),
						digitalAssets: new MemColl(),
						digitalEntitlements: new MemColl(),
						productAssetLinks: new MemColl(),
						productAssets: new MemColl(),
						bundleComponents: new MemColl(new Map([[componentLink.id, componentLink]])),
					},
				}),
			),
		).rejects.toMatchObject({ code: "insufficient_stock" });
	});
});
