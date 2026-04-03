import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash.js";
import { inventoryStockDocId } from "../orchestration/finalize-payment.js";
import type { CheckoutInput } from "../schemas.js";
import type {
	StoredCart,
	StoredIdempotencyKey,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
} from "../types.js";
import { checkoutHandler } from "./checkout.js";

type MemCollection<T extends object> = {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
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
}): RouteContext<CheckoutInput> {
	const req = new Request("https://example.local/checkout", {
		method: requestMethod,
		headers: new Headers({ "Idempotency-Key": idempotencyKey }),
	});
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

	it("serves fresh idempotent replay on repeated successful checkout calls", async () => {
		const cartId = "cart_2";
		const idempotencyKey = "idem-key-strong-2";
		const now = "2026-04-02T12:00:00.000Z";
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
			lineItems: [
				{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 },
			],
			ownerTokenHash: sha256Hex(ownerSecret),
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
			lineItems: [
				{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 },
			],
			ownerTokenHash: sha256Hex(ownerSecret),
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
			lineItems: [
				{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 },
			],
			ownerTokenHash: sha256Hex("correct-owner-token-12345"),
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

	it("allows checkout without ownerToken for legacy cart without ownerTokenHash", async () => {
		const cartId = "cart_legacy_co";
		const idempotencyKey = "idem-key-legacy-16";
		const now = "2026-04-02T12:00:00.000Z";
		const cart: StoredCart = {
			currency: "USD",
			lineItems: [
				{ productId: "p1", quantity: 1, inventoryVersion: 1, unitPriceMinor: 100 },
			],
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

		const out = await checkoutHandler(ctx);
		expect(out.paymentPhase).toBe("payment_pending");
		expect(out.currency).toBe("USD");
	});
});
