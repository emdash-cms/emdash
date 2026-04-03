import type { RouteContext, StorageCollection } from "emdash";

import { sha256HexAsync } from "../lib/crypto-adapter.js";
import type { CheckoutInput } from "../schemas.js";
import type {
	StoredIdempotencyKey,
	StoredOrder,
	StoredPaymentAttempt,
} from "../types.js";
import { resolvePaymentProviderId as resolvePaymentProviderIdFromContracts } from "../services/commerce-provider-contracts.js";

export const CHECKOUT_ROUTE = "checkout";
export const CHECKOUT_PENDING_KIND = "checkout_pending";

export type CheckoutPendingState = {
	kind: typeof CHECKOUT_PENDING_KIND;
	orderId: string;
	paymentAttemptId: string;
	providerId?: string;
	cartId: string;
	paymentPhase: "payment_pending";
	finalizeToken: string;
	totalMinor: number;
	currency: string;
	lineItems: Array<{
		productId: string;
		variantId?: string;
		quantity: number;
		inventoryVersion: number;
		unitPriceMinor: number;
	}>;
	createdAt: string;
};

export type CheckoutResponse = {
	orderId: string;
	paymentPhase: "payment_pending";
	paymentAttemptId: string;
	totalMinor: number;
	currency: string;
	finalizeToken: string;
};

export type CheckoutReplayDecision =
	| { kind: "cached_completed"; response: CheckoutResponse }
	| { kind: "cached_pending"; pending: CheckoutPendingState }
	| { kind: "not_cached" };

export const resolvePaymentProviderId = resolvePaymentProviderIdFromContracts;

export function isObjectLike(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isCheckoutCompletedResponse(value: unknown): value is CheckoutResponse {
	if (!isObjectLike(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.kind !== CHECKOUT_PENDING_KIND &&
		candidate.orderId != null &&
		typeof candidate.orderId === "string" &&
		candidate.paymentPhase === "payment_pending" &&
		candidate.paymentAttemptId != null &&
		typeof candidate.paymentAttemptId === "string" &&
		typeof candidate.totalMinor === "number" &&
		typeof candidate.currency === "string" &&
		typeof candidate.finalizeToken === "string" &&
		candidate.cartId === undefined &&
		candidate.lineItems === undefined
	);
}

export function isCheckoutPendingState(value: unknown): value is CheckoutPendingState {
	if (!isObjectLike(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.kind === CHECKOUT_PENDING_KIND &&
		typeof candidate.orderId === "string" &&
		typeof candidate.paymentAttemptId === "string" &&
		typeof candidate.cartId === "string" &&
		candidate.paymentPhase === "payment_pending" &&
		typeof candidate.finalizeToken === "string" &&
		typeof candidate.totalMinor === "number" &&
		typeof candidate.currency === "string" &&
		Array.isArray(candidate.lineItems)
	);
}

export function decideCheckoutReplayState(response: StoredIdempotencyKey | null): CheckoutReplayDecision {
	if (!response) return { kind: "not_cached" };
	if (isCheckoutCompletedResponse(response.responseBody)) {
		return { kind: "cached_completed", response: response.responseBody };
	}
	if (isCheckoutPendingState(response.responseBody)) {
		return { kind: "cached_pending", pending: response.responseBody };
	}
	return { kind: "not_cached" };
}

function checkoutResponseFromPendingState(state: CheckoutPendingState): CheckoutResponse {
	return {
		orderId: state.orderId,
		paymentPhase: "payment_pending",
		paymentAttemptId: state.paymentAttemptId,
		totalMinor: state.totalMinor,
		currency: state.currency,
		finalizeToken: state.finalizeToken,
	};
}

export async function restorePendingCheckout(
	idempotencyDocId: string,
	cached: StoredIdempotencyKey,
	pending: CheckoutPendingState,
	nowIso: string,
	idempotencyKeys: StorageCollection<StoredIdempotencyKey>,
	orders: StorageCollection<StoredOrder>,
	attempts: StorageCollection<StoredPaymentAttempt>,
): Promise<CheckoutResponse> {
	const existingOrder = await orders.get(pending.orderId);
	if (!existingOrder) {
		const finalizeTokenHash = await sha256HexAsync(pending.finalizeToken);
		await orders.put(pending.orderId, {
			cartId: pending.cartId,
			paymentPhase: pending.paymentPhase,
			currency: pending.currency,
			lineItems: pending.lineItems,
			totalMinor: pending.totalMinor,
			finalizeTokenHash,
			createdAt: pending.createdAt,
			updatedAt: nowIso,
		});
	}

	const existingAttempt = await attempts.get(pending.paymentAttemptId);
	if (!existingAttempt) {
		await attempts.put(pending.paymentAttemptId, {
			orderId: pending.orderId,
			providerId: resolvePaymentProviderId(pending.providerId),
			status: "pending",
			createdAt: pending.createdAt,
			updatedAt: nowIso,
		});
	}

	const response = checkoutResponseFromPendingState(pending);
	await idempotencyKeys.put(idempotencyDocId, {
		...cached,
		httpStatus: 200,
		responseBody: response,
	});
	return response;
}

export function deterministicOrderId(keyHash: string): string {
	return `checkout-order:${keyHash}`;
}

export function deterministicPaymentAttemptId(keyHash: string): string {
	return `checkout-attempt:${keyHash}`;
}

export type CheckoutStateInput = CheckoutInput & {
	idempotencyRouteKey: string;
	cartFingerprint: string;
	cartUpdatedAt: string;
	nowIso: string;
};
