import { describe, expect, it } from "vitest";

import { sha256HexAsync } from "../lib/crypto-adapter.js";
import {
	CHECKOUT_PENDING_KIND,
	CHECKOUT_ROUTE,
	type CheckoutPendingState,
	computeCheckoutReplayIntegrity,
	deterministicOrderId,
	deterministicPaymentAttemptId,
	decideCheckoutReplayState,
	restorePendingCheckout,
	resolvePaymentProviderId,
	validateCachedCheckoutCompleted,
} from "./checkout-state.js";
import type { StoredIdempotencyKey, StoredOrder, StoredPaymentAttempt } from "../types.js";
import type { StorageCollection } from "emdash";

type MemCollection<T extends object> = {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	rows: Map<string, T>;
};
function asStorageCollection<T extends object>(collection: MemCollection<T>): StorageCollection<T> {
	return collection as unknown as StorageCollection<T>;
}

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

const NOW = "2026-04-02T12:00:00.000Z";
const REPLAY_INTEGRITY_HEX64 = /^[a-f0-9]{64}$/;

function checkoutPendingFixture(overrides: Partial<CheckoutPendingState> = {}): CheckoutPendingState {
	return {
		kind: CHECKOUT_PENDING_KIND,
		orderId: "order-1",
		paymentAttemptId: "attempt-1",
		providerId: "stripe",
		cartId: "cart-1",
		paymentPhase: "payment_pending",
		finalizeToken: "pending-token-123",
		totalMinor: 1500,
		currency: "USD",
		lineItems: [
			{
				productId: "p-1",
				variantId: "v-1",
				quantity: 2,
				inventoryVersion: 4,
				unitPriceMinor: 750,
			},
		],
		createdAt: NOW,
		...overrides,
	};
}

describe("decideCheckoutReplayState", () => {
	it("returns not_cached when there is no idempotency row", () => {
		expect(decideCheckoutReplayState(null)).toEqual({ kind: "not_cached" });
	});

	it("returns not_cached when cached body is not a recognized response", () => {
		const cached = {
			route: CHECKOUT_ROUTE,
			keyHash: "k1",
			httpStatus: 200,
			responseBody: { random: "payload" },
			createdAt: NOW,
		} as unknown as StoredIdempotencyKey;
		expect(decideCheckoutReplayState(cached)).toEqual({ kind: "not_cached" });
	});

	it("returns cached_completed for finalized idempotency payload", () => {
		const cached = {
			route: CHECKOUT_ROUTE,
			keyHash: "k2",
			httpStatus: 200,
			responseBody: {
				orderId: "order-1",
				paymentPhase: "payment_pending",
				paymentAttemptId: "attempt-1",
				totalMinor: 1500,
				currency: "USD",
				finalizeToken: "pending-token-123",
			},
			createdAt: NOW,
		} as StoredIdempotencyKey;

		expect(decideCheckoutReplayState(cached)).toMatchObject({
			kind: "cached_completed",
			response: {
				orderId: "order-1",
				paymentPhase: "payment_pending",
				paymentAttemptId: "attempt-1",
				totalMinor: 1500,
				currency: "USD",
				finalizeToken: "pending-token-123",
			},
		});
	});

	it("returns cached_pending for pending checkout recovery payload", () => {
		const pending = checkoutPendingFixture();
		const cached = {
			route: CHECKOUT_ROUTE,
			keyHash: "k3",
			httpStatus: 202,
			responseBody: pending,
			createdAt: NOW,
		} as StoredIdempotencyKey;

		const decision = decideCheckoutReplayState(cached);
		expect(decision).toMatchObject({
			kind: "cached_pending",
			pending: pending,
		});
	});
});

describe("restorePendingCheckout", () => {
	it("reconstructs missing order + attempt, then promotes cache response to completed", async () => {
		const pending = checkoutPendingFixture();
		const cached: StoredIdempotencyKey = {
			route: CHECKOUT_ROUTE,
			keyHash: "k4",
			httpStatus: 202,
			responseBody: pending,
			createdAt: NOW,
		};
		const orders = new MemColl<StoredOrder>();
		const attempts = new MemColl<StoredPaymentAttempt>();
		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();

		const response = await restorePendingCheckout(
			"idemp:abc",
			cached,
			pending,
			NOW,
			asStorageCollection(idempotencyKeys),
			asStorageCollection(orders),
			asStorageCollection(attempts),
		);

		expect(response).toMatchObject({
			orderId: pending.orderId,
			paymentPhase: "payment_pending",
			paymentAttemptId: pending.paymentAttemptId,
			totalMinor: pending.totalMinor,
			currency: pending.currency,
			finalizeToken: pending.finalizeToken,
		});
		expect(response.replayIntegrity).toMatch(REPLAY_INTEGRITY_HEX64);
		const order = await orders.get(pending.orderId);
		expect(order).toEqual({
			cartId: pending.cartId,
			paymentPhase: pending.paymentPhase,
			currency: pending.currency,
			lineItems: pending.lineItems,
			totalMinor: pending.totalMinor,
			finalizeTokenHash: expect.any(String),
			createdAt: pending.createdAt,
			updatedAt: NOW,
		});
		const attempt = await attempts.get(pending.paymentAttemptId);
		expect(attempt).toEqual({
			orderId: pending.orderId,
			providerId: "stripe",
			status: "pending",
			createdAt: pending.createdAt,
			updatedAt: NOW,
		});
		const completedRow = await idempotencyKeys.get("idemp:abc");
		expect(completedRow?.httpStatus).toBe(200);
		expect(completedRow?.responseBody).toMatchObject({
			orderId: pending.orderId,
			paymentAttemptId: pending.paymentAttemptId,
			paymentPhase: "payment_pending",
			currency: "USD",
		});
	});

	it("keeps existing order and attempt when they already exist", async () => {
		const pending = checkoutPendingFixture();
		const cached: StoredIdempotencyKey = {
			route: CHECKOUT_ROUTE,
			keyHash: "k5",
			httpStatus: 202,
			responseBody: pending,
			createdAt: NOW,
		};
		const existingOrder: StoredOrder = {
			cartId: pending.cartId,
			paymentPhase: "payment_pending",
			currency: "USD",
			lineItems: pending.lineItems,
			totalMinor: 1500,
			finalizeTokenHash: await sha256HexAsync(pending.finalizeToken),
			createdAt: "2026-04-01T00:00:00.000Z",
			updatedAt: "2026-04-01T00:00:00.000Z",
		};
		const existingAttempt: StoredPaymentAttempt = {
			orderId: pending.orderId,
			providerId: "stripe",
			status: "pending",
			createdAt: "2026-04-01T00:00:00.000Z",
			updatedAt: "2026-04-01T00:00:00.000Z",
		};
		const orders = new MemColl<StoredOrder>(new Map([[pending.orderId, existingOrder]]));
		const attempts = new MemColl<StoredPaymentAttempt>(new Map([[pending.paymentAttemptId, existingAttempt]]));
		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();

		const response = await restorePendingCheckout(
			"idemp:existing",
			cached,
			pending,
			NOW,
			asStorageCollection(idempotencyKeys),
			asStorageCollection(orders),
			asStorageCollection(attempts),
		);

		expect(response).toMatchObject({
			orderId: pending.orderId,
			paymentAttemptId: pending.paymentAttemptId,
		});
		expect(response.replayIntegrity).toMatch(REPLAY_INTEGRITY_HEX64);
		expect(await orders.get(pending.orderId)).toEqual(existingOrder);
		expect(await attempts.get(pending.paymentAttemptId)).toEqual(existingAttempt);
	});

	it("fails replay restore if existing order no longer matches pending payload", async () => {
		const pending = checkoutPendingFixture();
		const cached: StoredIdempotencyKey = {
			route: CHECKOUT_ROUTE,
			keyHash: "k6",
			httpStatus: 202,
			responseBody: pending,
			createdAt: NOW,
		};
		const existingOrder: StoredOrder = {
			cartId: "other-cart",
			paymentPhase: "payment_pending",
			currency: "USD",
			lineItems: pending.lineItems,
			totalMinor: pending.totalMinor,
			finalizeTokenHash: await sha256HexAsync(pending.finalizeToken),
			createdAt: NOW,
			updatedAt: NOW,
		};
		const existingAttempt: StoredPaymentAttempt = {
			orderId: pending.orderId,
			providerId: resolvePaymentProviderId(pending.providerId),
			status: "pending",
			createdAt: NOW,
			updatedAt: NOW,
		};
		const orders = new MemColl<StoredOrder>(new Map([[pending.orderId, existingOrder]]));
		const attempts = new MemColl<StoredPaymentAttempt>(new Map([[pending.paymentAttemptId, existingAttempt]]));
		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();

		await expect(
			restorePendingCheckout(
				"idemp:order-mismatch",
				cached,
				pending,
				NOW,
			asStorageCollection(idempotencyKeys),
			asStorageCollection(orders),
			asStorageCollection(attempts),
			),
		).rejects.toMatchObject({ code: "order_state_conflict" });
		expect(await idempotencyKeys.get("idemp:order-mismatch")).toBeNull();
		expect(await orders.get(pending.orderId)).toEqual(existingOrder);
		expect(await attempts.get(pending.paymentAttemptId)).toEqual(existingAttempt);
	});

	it("fails replay restore if existing attempt no longer matches pending payload", async () => {
		const pending = checkoutPendingFixture();
		const cached: StoredIdempotencyKey = {
			route: CHECKOUT_ROUTE,
			keyHash: "k7",
			httpStatus: 202,
			responseBody: pending,
			createdAt: NOW,
		};
		const existingOrder: StoredOrder = {
			cartId: pending.cartId,
			paymentPhase: pending.paymentPhase,
			currency: pending.currency,
			lineItems: pending.lineItems,
			totalMinor: pending.totalMinor,
			finalizeTokenHash: await sha256HexAsync(pending.finalizeToken),
			createdAt: NOW,
			updatedAt: NOW,
		};
		const existingAttempt: StoredPaymentAttempt = {
			orderId: pending.orderId,
			providerId: resolvePaymentProviderId(pending.providerId),
			status: "succeeded",
			createdAt: NOW,
			updatedAt: NOW,
		};
		const orders = new MemColl<StoredOrder>(new Map([[pending.orderId, existingOrder]]));
		const attempts = new MemColl<StoredPaymentAttempt>(new Map([[pending.paymentAttemptId, existingAttempt]]));
		const idempotencyKeys = new MemColl<StoredIdempotencyKey>();

		await expect(
			restorePendingCheckout(
				"idemp:attempt-mismatch",
				cached,
				pending,
				NOW,
				asStorageCollection(idempotencyKeys),
				asStorageCollection(orders),
				asStorageCollection(attempts),
			),
		).rejects.toMatchObject({ code: "order_state_conflict" });
		expect(await idempotencyKeys.get("idemp:attempt-mismatch")).toBeNull();
		expect(await orders.get(pending.orderId)).toEqual(existingOrder);
		expect(await attempts.get(pending.paymentAttemptId)).toEqual(existingAttempt);
	});
});

describe("validateCachedCheckoutCompleted", () => {
	it("returns false when order or attempt is missing", async () => {
		const cached = {
			orderId: "o1",
			paymentPhase: "payment_pending" as const,
			paymentAttemptId: "a1",
			totalMinor: 100,
			currency: "USD",
			finalizeToken: "tok_______________________________",
		};
		expect(await validateCachedCheckoutCompleted("kh", cached, null, null)).toBe(false);
	});

	it("returns false when replayIntegrity does not match payload", async () => {
		const token = "tok_______________________________";
		const order: StoredOrder = {
			cartId: "c1",
			paymentPhase: "payment_pending",
			currency: "USD",
			lineItems: [],
			totalMinor: 100,
			finalizeTokenHash: await sha256HexAsync(token),
			createdAt: NOW,
			updatedAt: NOW,
		};
		const attempt: StoredPaymentAttempt = {
			orderId: "o1",
			providerId: "stripe",
			status: "pending",
			createdAt: NOW,
			updatedAt: NOW,
		};
		const cached = {
			orderId: "o1",
			paymentPhase: "payment_pending" as const,
			paymentAttemptId: "a1",
			totalMinor: 100,
			currency: "USD",
			finalizeToken: token,
			replayIntegrity: "deadbeef",
		};
		expect(await validateCachedCheckoutCompleted("kh", cached, order, attempt)).toBe(false);
	});

	it("returns true when replayIntegrity matches and rows align", async () => {
		const token = "tok_______________________________";
		const keyHash = "keyh";
		const order: StoredOrder = {
			cartId: "c1",
			paymentPhase: "payment_pending",
			currency: "USD",
			lineItems: [],
			totalMinor: 100,
			finalizeTokenHash: await sha256HexAsync(token),
			createdAt: NOW,
			updatedAt: NOW,
		};
		const attempt: StoredPaymentAttempt = {
			orderId: "o1",
			providerId: "stripe",
			status: "pending",
			createdAt: NOW,
			updatedAt: NOW,
		};
		const cached = {
			orderId: "o1",
			paymentPhase: "payment_pending" as const,
			paymentAttemptId: "a1",
			totalMinor: 100,
			currency: "USD",
			finalizeToken: token,
		};
		const replayIntegrity = await computeCheckoutReplayIntegrity(keyHash, cached);
		expect(
			await validateCachedCheckoutCompleted(
				keyHash,
				{ ...cached, replayIntegrity },
				order,
				attempt,
			),
		).toBe(true);
	});
});

describe("checkout id helpers", () => {
	it("normalizes payment provider ids", () => {
		expect(resolvePaymentProviderId(undefined)).toBe("stripe");
		expect(resolvePaymentProviderId("  ")).toBe("stripe");
		expect(resolvePaymentProviderId("paypal")).toBe("paypal");
	});

	it("builds deterministic ids from checkout hash keys", () => {
		expect(deterministicOrderId("abc123")).toBe("checkout-order:abc123");
		expect(deterministicPaymentAttemptId("abc123")).toBe("checkout-attempt:abc123");
	});
});
