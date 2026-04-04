import type { RouteContext, StorageCollection } from "emdash";

import { sha256HexAsync } from "../lib/crypto-adapter.js";
import type { CheckoutInput } from "../schemas.js";
import type {
	StoredIdempotencyKey,
	StoredOrder,
	StoredPaymentAttempt,
	OrderLineItem,
} from "../types.js";
import { resolvePaymentProviderId as resolvePaymentProviderIdFromContracts } from "../services/commerce-provider-contracts.js";
import { throwCommerceApiError } from "../route-errors.js";

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
	lineItems: OrderLineItem[];
	createdAt: string;
};

export type CheckoutResponse = {
	orderId: string;
	paymentPhase: "payment_pending";
	paymentAttemptId: string;
	totalMinor: number;
	currency: string;
	finalizeToken: string;
	/** Present on new writes; validates idempotency replay against live storage. */
	replayIntegrity?: string;
};

/** Wire shape returned to clients (no internal replay seal). */
export type CheckoutClientResponse = Omit<CheckoutResponse, "replayIntegrity">;

export function toCheckoutClientResponse(response: CheckoutResponse): CheckoutClientResponse {
	const { replayIntegrity: _replayIntegrity, ...out } = response;
	return out;
}

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
		candidate.lineItems === undefined &&
		(candidate.replayIntegrity === undefined || typeof candidate.replayIntegrity === "string")
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

type CheckoutReplayIntegrityInput = Pick<
	CheckoutResponse,
	"orderId" | "paymentAttemptId" | "totalMinor" | "currency" | "paymentPhase" | "finalizeToken"
>;

/** Deterministic seal for completed-checkout idempotency replay validation. */
export async function computeCheckoutReplayIntegrity(
	keyHash: string,
	response: CheckoutReplayIntegrityInput,
): Promise<string> {
	return sha256HexAsync(
		`${keyHash}|${response.orderId}|${response.paymentAttemptId}|${response.totalMinor}|${response.currency}|${response.paymentPhase}|${response.finalizeToken}`,
	);
}

/**
 * Returns true when cached completed response matches live order + attempt rows.
 * When `replayIntegrity` is absent (legacy cache), only structural + token-hash checks apply.
 */
export async function validateCachedCheckoutCompleted(
	keyHash: string,
	cached: CheckoutResponse,
	order: StoredOrder | null,
	attempt: StoredPaymentAttempt | null,
): Promise<boolean> {
	if (!order || !attempt) return false;
	if (attempt.orderId !== cached.orderId) return false;
	if (order.paymentPhase !== cached.paymentPhase) return false;
	if (order.totalMinor !== cached.totalMinor) return false;
	if (order.currency !== cached.currency) return false;
	if ((await sha256HexAsync(cached.finalizeToken)) !== order.finalizeTokenHash) return false;
	if (cached.replayIntegrity != null && cached.replayIntegrity.length > 0) {
		const expected = await computeCheckoutReplayIntegrity(keyHash, cached);
		if (expected !== cached.replayIntegrity) return false;
	}
	return true;
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
	const expectedProviderId = resolvePaymentProviderId(pending.providerId);
	const finalizeTokenHash = await sha256HexAsync(pending.finalizeToken);

	const existingOrder = await orders.get(pending.orderId);
	if (!existingOrder) {
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
	} else {
		const orderLineItemsMatch =
			existingOrder.lineItems.length === pending.lineItems.length &&
			existingOrder.lineItems.every((existingItem, index) => {
				const pendingItem = pending.lineItems[index];
				return (
					existingItem.productId === pendingItem.productId &&
					existingItem.variantId === pendingItem.variantId &&
					existingItem.quantity === pendingItem.quantity &&
					existingItem.inventoryVersion === pendingItem.inventoryVersion &&
					existingItem.unitPriceMinor === pendingItem.unitPriceMinor
				);
			});

		if (
			existingOrder.cartId !== pending.cartId ||
			existingOrder.paymentPhase !== pending.paymentPhase ||
			existingOrder.currency !== pending.currency ||
			existingOrder.totalMinor !== pending.totalMinor ||
			existingOrder.finalizeTokenHash !== finalizeTokenHash ||
			!orderLineItemsMatch
		) {
			throwCommerceApiError({
				code: "ORDER_STATE_CONFLICT",
				message: "Cached checkout recovery state no longer matches current order",
				details: {
					idempotencyKey: idempotencyDocId,
					orderId: pending.orderId,
				},
			});
		}
	}

	const existingAttempt = await attempts.get(pending.paymentAttemptId);
	if (!existingAttempt) {
		await attempts.put(pending.paymentAttemptId, {
			orderId: pending.orderId,
			providerId: expectedProviderId,
			status: "pending",
			createdAt: pending.createdAt,
			updatedAt: nowIso,
		});
	} else if (
		existingAttempt.orderId !== pending.orderId ||
		existingAttempt.providerId !== expectedProviderId ||
		existingAttempt.status !== "pending"
	) {
		throwCommerceApiError({
			code: "ORDER_STATE_CONFLICT",
			message: "Cached checkout recovery state no longer matches current payment attempt",
			details: {
				idempotencyKey: idempotencyDocId,
				paymentAttemptId: pending.paymentAttemptId,
			},
		});
	}

	const base = checkoutResponseFromPendingState(pending);
	const replayIntegrity = await computeCheckoutReplayIntegrity(cached.keyHash, base);
	const response: CheckoutResponse = { ...base, replayIntegrity };
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
