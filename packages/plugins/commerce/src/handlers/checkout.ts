/**
 * Checkout: cart → `payment_pending` order + `pending` payment attempt (Stripe session in a later slice).
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import { randomFinalizeTokenHex, sha256Hex } from "../hash.js";
import { validateIdempotencyKey } from "../kernel/idempotency-key.js";
import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { cartContentFingerprint } from "../lib/cart-fingerprint.js";
import { isIdempotencyRecordFresh } from "../lib/idempotency-ttl.js";
import { mergeLineItemsBySku } from "../lib/merge-line-items.js";
import { consumeKvRateLimit } from "../lib/rate-limit-kv.js";
import { requirePost } from "../lib/require-post.js";
import { inventoryStockDocId } from "../orchestration/finalize-payment.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { CheckoutInput } from "../schemas.js";
import type {
	StoredCart,
	StoredIdempotencyKey,
	StoredOrder,
	StoredPaymentAttempt,
	StoredInventoryStock,
	OrderLineItem,
} from "../types.js";

const CHECKOUT_ROUTE = "checkout";
const CHECKOUT_PENDING_KIND = "checkout_pending";

type CheckoutPendingState = {
	kind: typeof CHECKOUT_PENDING_KIND;
	orderId: string;
	paymentAttemptId: string;
	cartId: string;
	paymentPhase: "payment_pending";
	finalizeToken: string;
	totalMinor: number;
	currency: string;
	lineItems: OrderLineItem[];
	createdAt: string;
};

type CheckoutResponse = {
	orderId: string;
	paymentPhase: "payment_pending";
	paymentAttemptId: string;
	totalMinor: number;
	currency: string;
	finalizeToken: string;
};

type CheckoutReplayDecision =
	| { kind: "cached_completed"; response: CheckoutResponse }
	| { kind: "cached_pending"; pending: CheckoutPendingState }
	| { kind: "not_cached" };

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCheckoutCompletedResponse(value: unknown): value is CheckoutResponse {
	if (!isObjectLike(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.orderId != null &&
		typeof candidate.orderId === "string" &&
		candidate.paymentPhase === "payment_pending" &&
		candidate.paymentAttemptId != null &&
		typeof candidate.paymentAttemptId === "string" &&
		typeof candidate.totalMinor === "number" &&
		typeof candidate.currency === "string" &&
		typeof candidate.finalizeToken === "string"
	);
}

function decideCheckoutReplayState(response: StoredIdempotencyKey | null): CheckoutReplayDecision {
	if (!response) return { kind: "not_cached" };
	if (isCheckoutCompletedResponse(response.responseBody)) {
		return { kind: "cached_completed", response: response.responseBody };
	}
	if (isCheckoutPendingState(response.responseBody)) {
		return { kind: "cached_pending", pending: response.responseBody };
	}
	return { kind: "not_cached" };
}

async function restorePendingCheckout(
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
		await orders.put(pending.orderId, {
			cartId: pending.cartId,
			paymentPhase: pending.paymentPhase,
			currency: pending.currency,
			lineItems: pending.lineItems,
			totalMinor: pending.totalMinor,
			finalizeTokenHash: sha256Hex(pending.finalizeToken),
			createdAt: pending.createdAt,
			updatedAt: nowIso,
		});
	}

	const existingAttempt = await attempts.get(pending.paymentAttemptId);
	if (!existingAttempt) {
		await attempts.put(pending.paymentAttemptId, {
			orderId: pending.orderId,
			providerId: "stripe",
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

function isCheckoutPendingState(value: unknown): value is CheckoutPendingState {
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

function deterministicOrderId(keyHash: string): string {
	return `checkout-order:${keyHash}`;
}

function deterministicPaymentAttemptId(keyHash: string): string {
	return `checkout-attempt:${keyHash}`;
}

export async function checkoutHandler(ctx: RouteContext<CheckoutInput>) {
	requirePost(ctx);

	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();

	const headerKey = ctx.request.headers.get("Idempotency-Key")?.trim();
	const bodyKey = ctx.input.idempotencyKey?.trim();
	const idempotencyKey = bodyKey ?? headerKey;

	if (!validateIdempotencyKey(idempotencyKey)) {
		throw PluginRouteError.badRequest(
			"Idempotency-Key is required (header or body) and must be 16–128 printable ASCII characters",
		);
	}

	const ip = ctx.requestMeta.ip ?? "unknown";
	const ipHash = sha256Hex(ip).slice(0, 32);
	const allowed = await consumeKvRateLimit({
		kv: ctx.kv,
		keySuffix: `checkout:ip:${ipHash}`,
		limit: COMMERCE_LIMITS.defaultCheckoutPerIpPerWindow,
		windowMs: COMMERCE_LIMITS.defaultRateWindowMs,
		nowMs,
	});
	if (!allowed) {
		throwCommerceApiError({
			code: "RATE_LIMITED",
			message: "Too many checkout attempts; try again shortly",
		});
	}

	const carts = asCollection<StoredCart>(ctx.storage.carts);
	const cart = await carts.get(ctx.input.cartId);
	if (!cart) {
		throwCommerceApiError({ code: "CART_NOT_FOUND", message: "Cart not found" });
	}
	if (cart.lineItems.length === 0) {
		throwCommerceApiError({ code: "CART_EMPTY", message: "Cart has no line items" });
	}
	if (cart.lineItems.length > COMMERCE_LIMITS.maxCartLineItems) {
		throwCommerceApiError({
			code: "PAYLOAD_TOO_LARGE",
			message: `Cart exceeds maximum of ${COMMERCE_LIMITS.maxCartLineItems} line items`,
		});
	}
	for (const line of cart.lineItems) {
		if (
			!Number.isInteger(line.quantity) ||
			line.quantity < 1 ||
			line.quantity > COMMERCE_LIMITS.maxLineItemQty
		) {
			throw PluginRouteError.badRequest(
				`Line item quantity must be between 1 and ${COMMERCE_LIMITS.maxLineItemQty}`,
			);
		}
		if (!Number.isInteger(line.inventoryVersion) || line.inventoryVersion < 0) {
			throw PluginRouteError.badRequest(
				"Line item inventory version must be a non-negative integer",
			);
		}
		if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
			throw PluginRouteError.badRequest("Line item unit price must be a non-negative integer");
		}
	}

	const fingerprint = cartContentFingerprint(cart.lineItems);
	const keyHash = sha256Hex(
		`${CHECKOUT_ROUTE}|${ctx.input.cartId}|${cart.updatedAt}|${fingerprint}|${idempotencyKey}`,
	);
	const idempotencyDocId = `idemp:${keyHash}`;

	const idempotencyKeys = asCollection<StoredIdempotencyKey>(ctx.storage.idempotencyKeys);
	const cached = await idempotencyKeys.get(idempotencyDocId);
	if (cached && isIdempotencyRecordFresh(cached.createdAt, nowMs)) {
		const decision = decideCheckoutReplayState(cached);
		const orders = asCollection<StoredOrder>(ctx.storage.orders);
		const attempts = asCollection<StoredPaymentAttempt>(ctx.storage.paymentAttempts);
		switch (decision.kind) {
			case "cached_completed":
				return decision.response;
			case "cached_pending":
				return restorePendingCheckout(
					idempotencyDocId,
					cached,
					decision.pending,
					nowIso,
					idempotencyKeys,
					orders,
					attempts,
				);
			case "not_cached":
			default:
				break;
		}
	}

	const inventoryStock = asCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	for (const line of cart.lineItems) {
		const stockId = inventoryStockDocId(line.productId, line.variantId ?? "");
		const inv = await inventoryStock.get(stockId);
		if (!inv) {
			throwCommerceApiError({
				code: "PRODUCT_UNAVAILABLE",
				message: `Product is not available: ${line.productId}`,
			});
		}
		if (inv.quantity < line.quantity) {
			throwCommerceApiError({
				code: "INSUFFICIENT_STOCK",
				message: `Insufficient stock for product ${line.productId}`,
			});
		}
	}

	let orderLineItems: OrderLineItem[];
	try {
		orderLineItems = mergeLineItemsBySku(
			cart.lineItems.map((l) => ({
				productId: l.productId,
				variantId: l.variantId,
				quantity: l.quantity,
				inventoryVersion: l.inventoryVersion,
				unitPriceMinor: l.unitPriceMinor,
			})),
		);
	} catch {
		throw PluginRouteError.badRequest(
			"Cart has duplicate SKUs with conflicting price or inventory version snapshots",
		);
	}

	const totalMinor = orderLineItems.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
	const orderId = deterministicOrderId(keyHash);

	const finalizeToken = randomFinalizeTokenHex();
	const finalizeTokenHash = sha256Hex(finalizeToken);

	const order: StoredOrder = {
		cartId: ctx.input.cartId,
		paymentPhase: "payment_pending",
		currency: cart.currency,
		lineItems: orderLineItems,
		totalMinor,
		finalizeTokenHash,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const paymentAttemptId = deterministicPaymentAttemptId(keyHash);
	const attempt: StoredPaymentAttempt = {
		orderId,
		providerId: "stripe",
		status: "pending",
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const pendingState: CheckoutPendingState = {
		kind: CHECKOUT_PENDING_KIND,
		orderId,
		paymentAttemptId,
		cartId: ctx.input.cartId,
		paymentPhase: "payment_pending",
		finalizeToken,
		totalMinor,
		currency: cart.currency,
		lineItems: orderLineItems,
		createdAt: nowIso,
	};

	await idempotencyKeys.put(idempotencyDocId, {
		route: CHECKOUT_ROUTE,
		keyHash,
		httpStatus: 202,
		responseBody: pendingState,
		createdAt: nowIso,
	});

	const orders = asCollection<StoredOrder>(ctx.storage.orders);
	const attempts = asCollection<StoredPaymentAttempt>(ctx.storage.paymentAttempts);
	await orders.put(orderId, order);
	await attempts.put(paymentAttemptId, attempt);

	const responseBody = {
		orderId,
		paymentPhase: order.paymentPhase,
		paymentAttemptId,
		totalMinor,
		currency: cart.currency,
		finalizeToken,
	};

	await idempotencyKeys.put(idempotencyDocId, {
		route: CHECKOUT_ROUTE,
		keyHash,
		httpStatus: 200,
		responseBody,
		createdAt: nowIso,
	});

	return responseBody;
}
