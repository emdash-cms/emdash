/**
 * Checkout: cart → `payment_pending` order + `pending` payment attempt (Stripe session in a later slice).
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";
import { ulid } from "ulidx";

import { sha256Hex } from "../hash.js";
import { validateIdempotencyKey } from "../kernel/idempotency-key.js";
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

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

export async function checkoutHandler(ctx: RouteContext<CheckoutInput>) {
	const headerKey = ctx.request.headers.get("Idempotency-Key")?.trim();
	const bodyKey = ctx.input.idempotencyKey?.trim();
	const idempotencyKey = bodyKey ?? headerKey;

	if (!validateIdempotencyKey(idempotencyKey)) {
		throw PluginRouteError.badRequest(
			"Idempotency-Key is required (header or body) and must be 16–128 printable ASCII characters",
		);
	}

	const keyHash = sha256Hex(`${CHECKOUT_ROUTE}|${ctx.input.cartId}|${idempotencyKey}`);
	const idempotencyDocId = `idemp:${keyHash}`;

	const idempotencyKeys = asCollection<StoredIdempotencyKey>(ctx.storage.idempotencyKeys);
	const cached = await idempotencyKeys.get(idempotencyDocId);
	if (cached) {
		return cached.responseBody;
	}

	const carts = asCollection<StoredCart>(ctx.storage.carts);
	const cart = await carts.get(ctx.input.cartId);
	if (!cart) {
		throwCommerceApiError({ code: "CART_NOT_FOUND", message: "Cart not found" });
	}
	if (cart.lineItems.length === 0) {
		throwCommerceApiError({ code: "CART_EMPTY", message: "Cart has no line items" });
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

	const orderLineItems: OrderLineItem[] = cart.lineItems.map((l) => ({
		productId: l.productId,
		variantId: l.variantId,
		quantity: l.quantity,
		inventoryVersion: l.inventoryVersion,
		unitPriceMinor: l.unitPriceMinor,
	}));

	const totalMinor = orderLineItems.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
	const now = new Date().toISOString();
	const orderId = ulid();

	const order: StoredOrder = {
		cartId: ctx.input.cartId,
		paymentPhase: "payment_pending",
		currency: cart.currency,
		lineItems: orderLineItems,
		totalMinor,
		createdAt: now,
		updatedAt: now,
	};

	const paymentAttemptId = ulid();
	const attempt: StoredPaymentAttempt = {
		orderId,
		providerId: "stripe",
		status: "pending",
		createdAt: now,
		updatedAt: now,
	};

	await asCollection<StoredOrder>(ctx.storage.orders).put(orderId, order);
	await asCollection<StoredPaymentAttempt>(ctx.storage.paymentAttempts).put(paymentAttemptId, attempt);

	const responseBody = {
		orderId,
		paymentPhase: order.paymentPhase,
		paymentAttemptId,
		totalMinor,
		currency: cart.currency,
	};

	await idempotencyKeys.put(idempotencyDocId, {
		route: CHECKOUT_ROUTE,
		keyHash,
		httpStatus: 200,
		responseBody,
		createdAt: now,
	});

	return responseBody;
}
