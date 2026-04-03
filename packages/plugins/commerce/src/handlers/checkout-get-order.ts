/**
 * Read-only order snapshot for storefront SSR (Astro) and form posts.
 * Every order must carry `finalizeTokenHash` (checkout always sets it); the raw
 * `finalizeToken` from checkout must be supplied — `orderId` alone is never sufficient.
 * Legacy rows without a hash are not exposed (404) so IDs cannot be enumerated.
 */

import type { RouteContext, StorageCollection } from "emdash";

import { equalSha256HexDigest, sha256Hex } from "../hash.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { CheckoutGetOrderInput } from "../schemas.js";
import type { StoredOrder } from "../types.js";

export type CheckoutGetOrderResponse = {
	order: Omit<StoredOrder, "finalizeTokenHash">;
};

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

function toPublicOrder(order: StoredOrder): CheckoutGetOrderResponse["order"] {
	const { finalizeTokenHash: _omit, ...rest } = order;
	return rest;
}

export async function checkoutGetOrderHandler(
	ctx: RouteContext<CheckoutGetOrderInput>,
): Promise<CheckoutGetOrderResponse> {
	requirePost(ctx);

	const orders = asCollection<StoredOrder>(ctx.storage.orders);
	const order = await orders.get(ctx.input.orderId);
	if (!order) {
		throwCommerceApiError({ code: "ORDER_NOT_FOUND", message: "Order not found" });
	}

	const expectedHash = order.finalizeTokenHash;
	if (!expectedHash) {
		throwCommerceApiError({ code: "ORDER_NOT_FOUND", message: "Order not found" });
	}

	const token = ctx.input.finalizeToken?.trim();
	if (!token) {
		throwCommerceApiError({
			code: "WEBHOOK_SIGNATURE_INVALID",
			message: "finalizeToken is required to read this order",
		});
	}
	const digest = sha256Hex(token);
	if (!equalSha256HexDigest(digest, expectedHash)) {
		throwCommerceApiError({
			code: "WEBHOOK_SIGNATURE_INVALID",
			message: "Invalid finalize token for this order",
		});
	}

	return { order: toPublicOrder(order) };
}
