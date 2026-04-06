/**
 * Read-only order snapshot for storefront SSR (Astro) and form posts.
 * Every order carries `finalizeTokenHash` (checkout always sets it), and callers
 * must present the raw `finalizeToken` to read it.
 */

import type { RouteContext } from "emdash";

import { equalSha256HexDigestAsync, sha256HexAsync } from "../lib/crypto-adapter.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { CheckoutGetOrderInput } from "../schemas.js";
import type { StoredOrder } from "../types.js";
import { asCollection } from "./catalog-conflict.js";

export type CheckoutGetOrderResponse = {
	order: Omit<StoredOrder, "finalizeTokenHash">;
};

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
		throwCommerceApiError({ code: "ORDER_NOT_FOUND", message: "Order token missing from storage" });
	}

	const token = ctx.input.finalizeToken?.trim();
	if (!token) {
		throwCommerceApiError({
			code: "ORDER_TOKEN_REQUIRED",
			message: "finalizeToken is required to read this order",
		});
	}
	const digest = await sha256HexAsync(token);
	if (!(await equalSha256HexDigestAsync(digest, expectedHash))) {
		throwCommerceApiError({
			code: "ORDER_TOKEN_INVALID",
			message: "Invalid finalize token for this order",
		});
	}

	return { order: toPublicOrder(order) };
}
