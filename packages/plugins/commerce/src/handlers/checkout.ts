/**
 * Checkout: cart → `payment_pending` order + `pending` payment attempt (Stripe session in a later slice).
 * When the cart has `ownerTokenHash`, `ownerToken` must match (same possession proof as `cart/get`).
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import { validateIdempotencyKey } from "../kernel/idempotency-key.js";
import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { cartContentFingerprint } from "../lib/cart-fingerprint.js";
import { projectCartLineItemsForStorage } from "../lib/cart-lines.js";
import { assertCartOwnerToken } from "../lib/cart-owner-token.js";
import { validateCartLineItems } from "../lib/cart-validation.js";
import { randomHex, sha256HexAsync } from "../lib/crypto-adapter.js";
import { isIdempotencyRecordFresh } from "../lib/idempotency-ttl.js";
import { mergeLineItemsBySku } from "../lib/merge-line-items.js";
import { consumeKvRateLimit } from "../lib/rate-limit-kv.js";
import { buildRateLimitActorKey } from "../lib/rate-limit-identity.js";
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
import {
	CheckoutPendingState,
	CHECKOUT_PENDING_KIND,
	CHECKOUT_ROUTE,
	decideCheckoutReplayState,
	deterministicOrderId,
	deterministicPaymentAttemptId,
	restorePendingCheckout,
	resolvePaymentProviderId,
} from "./checkout-state.js";

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

export async function checkoutHandler(
	ctx: RouteContext<CheckoutInput>,
	paymentProviderId?: string,
) {
	requirePost(ctx);
	const resolvedPaymentProviderId = resolvePaymentProviderId(paymentProviderId);

	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();

	const headerKey = ctx.request.headers.get("Idempotency-Key")?.trim() || undefined;
	const bodyKey = ctx.input.idempotencyKey?.trim() || undefined;

	if (headerKey && bodyKey && headerKey !== bodyKey) {
		throw PluginRouteError.badRequest(
			"Idempotency-Key conflict: header and body values must match when both are supplied",
		);
	}

	const idempotencyKey = bodyKey ?? headerKey;

	if (!validateIdempotencyKey(idempotencyKey)) {
		throw PluginRouteError.badRequest(
			"Idempotency-Key is required (header or body) and must be 16–128 printable ASCII characters",
		);
	}

	const ipHash = await buildRateLimitActorKey(ctx, "checkout");
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
	await assertCartOwnerToken(cart, ctx.input.ownerToken, "checkout");
	if (cart.lineItems.length === 0) {
		throwCommerceApiError({ code: "CART_EMPTY", message: "Cart has no line items" });
	}
	if (cart.lineItems.length > COMMERCE_LIMITS.maxCartLineItems) {
		throwCommerceApiError({
			code: "PAYLOAD_TOO_LARGE",
			message: `Cart exceeds maximum of ${COMMERCE_LIMITS.maxCartLineItems} line items`,
		});
	}
	const lineItemValidationMessage = validateCartLineItems(cart.lineItems);
	if (lineItemValidationMessage) {
		throw PluginRouteError.badRequest(lineItemValidationMessage);
	}

	const fingerprint = cartContentFingerprint(cart.lineItems);
	const keyHash = await sha256HexAsync(
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
				return await restorePendingCheckout(
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
		orderLineItems = mergeLineItemsBySku(projectCartLineItemsForStorage(cart.lineItems));
	} catch {
		throw PluginRouteError.badRequest(
			"Cart has duplicate SKUs with conflicting price or inventory version snapshots",
		);
	}

	const totalMinor = orderLineItems.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
	const orderId = deterministicOrderId(keyHash);

	const finalizeToken = await randomHex(24);
	const finalizeTokenHash = await sha256HexAsync(finalizeToken);

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
		providerId: resolvedPaymentProviderId,
		status: "pending",
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const pendingState: CheckoutPendingState = {
		kind: CHECKOUT_PENDING_KIND,
		orderId,
		paymentAttemptId,
		providerId: resolvedPaymentProviderId,
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
