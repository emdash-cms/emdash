/**
 * Checkout: cart → `payment_pending` order + `pending` payment attempt (Stripe session in a later slice).
 * When the cart has `ownerTokenHash`, `ownerToken` must match (same possession proof as `cart/get`).
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import { validateIdempotencyKey } from "../kernel/idempotency-key.js";
import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { cartContentFingerprint } from "../lib/cart-fingerprint.js";
import { buildOrderLineSnapshots } from "../lib/catalog-order-snapshots.js";
import { validateLineItemsStockForCheckout } from "../lib/checkout-inventory-validation.js";
import { projectCartLineItemsForStorage } from "../lib/cart-lines.js";
import { assertCartOwnerToken } from "../lib/cart-owner-token.js";
import { validateCartLineItems } from "../lib/cart-validation.js";
import { randomHex, sha256HexAsync } from "../lib/crypto-adapter.js";
import { isIdempotencyRecordFresh } from "../lib/idempotency-ttl.js";
import { LineConflictError, mergeLineItemsBySku } from "../lib/merge-line-items.js";
import { consumeKvRateLimit } from "../lib/rate-limit-kv.js";
import { buildRateLimitActorKey } from "../lib/rate-limit-identity.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { CheckoutInput } from "../schemas.js";
import type {
	StoredCart,
	StoredIdempotencyKey,
	StoredOrder,
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductSku,
	StoredProductSkuOptionValue,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredBundleComponent,
	StoredPaymentAttempt,
	StoredInventoryStock,
	OrderLineItem,
} from "../types.js";
import type { CheckoutPendingState, CheckoutResponse } from "./checkout-state.js";
import {
	CHECKOUT_PENDING_KIND,
	CHECKOUT_ROUTE,
	computeCheckoutReplayIntegrity,
	decideCheckoutReplayState,
	deterministicOrderId,
	deterministicPaymentAttemptId,
	restorePendingCheckout,
	resolvePaymentProviderId,
	toCheckoutClientResponse,
	validateCachedCheckoutCompleted,
} from "./checkout-state.js";
import { asCollection } from "./catalog-conflict.js";

type SnapshotQueryCollection<T> = {
	get(id: string): Promise<T | null>;
	query(options?: { where?: Record<string, unknown>; limit?: number }): Promise<{ items: Array<{ id: string; data: T }>; hasMore: boolean }>;
};

function asSnapshotCollection<T>(raw: unknown): SnapshotQueryCollection<T> {
	if (raw) {
		const collection = raw as { get: (id: string) => Promise<T | null>; query?: SnapshotQueryCollection<T>["query"] };
		return {
			get: collection.get.bind(collection),
			query: collection.query ? collection.query.bind(collection) : async () => ({ items: [], hasMore: false }),
		};
	}
	return {
		async get() {
			return null;
		},
		async query() {
			return { items: [], hasMore: false };
		},
	};
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
	const orders = asCollection<StoredOrder>(ctx.storage.orders);
	const attempts = asCollection<StoredPaymentAttempt>(ctx.storage.paymentAttempts);
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
		switch (decision.kind) {
			case "cached_completed":
				const cachedOrder = await orders.get(decision.response.orderId);
				const cachedAttempt = await attempts.get(decision.response.paymentAttemptId);
				if (
					!(await validateCachedCheckoutCompleted(
						keyHash,
						decision.response,
						cachedOrder,
						cachedAttempt,
					))
				) {
					break;
				}
				return toCheckoutClientResponse(decision.response);
			case "cached_pending":
				return toCheckoutClientResponse(
					await restorePendingCheckout(
						idempotencyDocId,
						cached,
						decision.pending,
						nowIso,
						idempotencyKeys,
						orders,
						attempts,
					),
				);
			case "not_cached":
			default:
				break;
		}
	}

	const inventoryStock = asCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	await validateLineItemsStockForCheckout(cart.lineItems, {
		products: asCollection(ctx.storage.products),
		bundleComponents: asCollection(ctx.storage.bundleComponents),
		productSkus: asCollection(ctx.storage.productSkus),
		inventoryStock,
	});

	let orderLineItems: OrderLineItem[];
	try {
		orderLineItems = mergeLineItemsBySku(projectCartLineItemsForStorage(cart.lineItems));
	} catch (error) {
		if (error instanceof LineConflictError) {
			throwCommerceApiError({
				code: "ORDER_STATE_CONFLICT",
				message: error.message,
				details: {
					reason: "line_conflict",
					productId: error.productId,
					variantId: error.variantId ?? null,
					expected: error.expected,
					actual: error.actual,
				},
			});
		}
		throw PluginRouteError.badRequest(
			"Cart has duplicate SKUs with conflicting price or inventory version snapshots",
		);
	}

	const productSnapshots = await buildOrderLineSnapshots(orderLineItems, cart.currency, {
		products: asSnapshotCollection<StoredProduct>(ctx.storage.products),
		productSkus: asSnapshotCollection<StoredProductSku>(ctx.storage.productSkus),
		productSkuOptionValues: asSnapshotCollection<StoredProductSkuOptionValue>(
			ctx.storage.productSkuOptionValues,
		),
		productDigitalAssets: asSnapshotCollection<StoredDigitalAsset>(ctx.storage.digitalAssets),
		productDigitalEntitlements: asSnapshotCollection<StoredDigitalEntitlement>(ctx.storage.digitalEntitlements),
		productAssetLinks: asSnapshotCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks),
		productAssets: asSnapshotCollection<StoredProductAsset>(ctx.storage.productAssets),
		bundleComponents: asSnapshotCollection<StoredBundleComponent>(ctx.storage.bundleComponents),
		inventoryStock: {
			get: (id: string) => inventoryStock.get(id),
		},
	});
	const orderLineItemsWithSnapshots = orderLineItems.map((line, index) => ({
		...line,
		snapshot: productSnapshots[index],
		unitPriceMinor: productSnapshots[index]?.unitPriceMinor ?? line.unitPriceMinor,
	}));

	const totalMinor = orderLineItemsWithSnapshots.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
	const orderId = deterministicOrderId(keyHash);

	const finalizeToken = await randomHex(24);
	const finalizeTokenHash = await sha256HexAsync(finalizeToken);

	const order: StoredOrder = {
		cartId: ctx.input.cartId,
		paymentPhase: "payment_pending",
		currency: cart.currency,
		lineItems: orderLineItemsWithSnapshots,
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
		lineItems: orderLineItemsWithSnapshots,
		createdAt: nowIso,
	};

	await idempotencyKeys.put(idempotencyDocId, {
		route: CHECKOUT_ROUTE,
		keyHash,
		httpStatus: 202,
		responseBody: pendingState,
		createdAt: nowIso,
	});

	await orders.put(orderId, order);
	await attempts.put(paymentAttemptId, attempt);

	const responseBody: CheckoutResponse = {
		orderId,
		paymentPhase: "payment_pending",
		paymentAttemptId,
		totalMinor,
		currency: cart.currency,
		finalizeToken,
	};
	const replayIntegrity = await computeCheckoutReplayIntegrity(keyHash, responseBody);

	await idempotencyKeys.put(idempotencyDocId, {
		route: CHECKOUT_ROUTE,
		keyHash,
		httpStatus: 200,
		responseBody: { ...responseBody, replayIntegrity },
		createdAt: nowIso,
	});

	return responseBody;
}
