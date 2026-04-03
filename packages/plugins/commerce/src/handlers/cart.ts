/**
 * Cart handlers: upsert and get.
 *
 * Ownership model
 * ---------------
 * On first creation the server issues an opaque `ownerToken` (random hex, 24 bytes).
 * Only the SHA-256 hash is stored on the cart document (`ownerTokenHash`).
 * The raw token is returned once in the creation response and must be presented
 * by the caller on all subsequent mutations.
 *
 * This is intentionally the same pattern as `finalizeToken`/`finalizeTokenHash`
 * on orders — it gives us a future-proof ownership surface without requiring a
 * full auth session, and without any breaking API changes when sessions arrive.
 *
 * Rate limiting
 * -------------
 * Mutations are rate-limited per cart token hash (not IP) so that a shared
 * storefront origin does not exhaust a single IP bucket.
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import { equalSha256HexDigest, randomFinalizeTokenHex, sha256Hex } from "../hash.js";
import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { consumeKvRateLimit } from "../lib/rate-limit-kv.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { CartGetInput, CartUpsertInput } from "../schemas.js";
import type { StoredCart } from "../types.js";

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

// ---------------------------------------------------------------------------
// cart/upsert
// ---------------------------------------------------------------------------

export type CartUpsertResponse = {
	cartId: string;
	currency: string;
	lineItemCount: number;
	updatedAt: string;
	/**
	 * Only present on cart creation (first upsert).
	 * The caller must store this token — it is never returned again.
	 * Required for all subsequent mutations.
	 */
	ownerToken?: string;
};

export async function cartUpsertHandler(
	ctx: RouteContext<CartUpsertInput>,
): Promise<CartUpsertResponse> {
	requirePost(ctx);

	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();

	const carts = asCollection<StoredCart>(ctx.storage.carts);
	const existing = await carts.get(ctx.input.cartId);

	// --- Ownership check ---
	if (existing?.ownerTokenHash) {
		const presented = ctx.input.ownerToken;
		if (!presented) {
			throwCommerceApiError({
				code: "CART_TOKEN_REQUIRED",
				message: "An owner token is required to modify this cart",
			});
		}
		const presentedHash = sha256Hex(presented);
		if (!equalSha256HexDigest(presentedHash, existing.ownerTokenHash)) {
			throwCommerceApiError({
				code: "CART_TOKEN_INVALID",
				message: "Owner token is invalid",
			});
		}
	}

	// --- Rate limit: keyed on token hash (or cartId for legacy/new carts) ---
	const rateLimitKey = existing?.ownerTokenHash
		? `cart:token:${existing.ownerTokenHash.slice(0, 32)}`
		: `cart:id:${sha256Hex(ctx.input.cartId).slice(0, 32)}`;

	const allowed = await consumeKvRateLimit({
		kv: ctx.kv,
		keySuffix: rateLimitKey,
		limit: COMMERCE_LIMITS.defaultCartMutationsPerTokenPerWindow,
		windowMs: COMMERCE_LIMITS.defaultRateWindowMs,
		nowMs,
	});
	if (!allowed) {
		throwCommerceApiError({
			code: "RATE_LIMITED",
			message: "Too many cart mutations; try again shortly",
		});
	}

	// --- Validate line items ---
	if (ctx.input.lineItems.length > COMMERCE_LIMITS.maxCartLineItems) {
		throwCommerceApiError({
			code: "PAYLOAD_TOO_LARGE",
			message: `Cart must not exceed ${COMMERCE_LIMITS.maxCartLineItems} line items`,
		});
	}
	for (const line of ctx.input.lineItems) {
		if (
			!Number.isInteger(line.quantity) ||
			line.quantity < 1 ||
			line.quantity > COMMERCE_LIMITS.maxLineItemQty
		) {
			throw new PluginRouteError(
				"VALIDATION_ERROR",
				`Line item quantity must be between 1 and ${COMMERCE_LIMITS.maxLineItemQty}`,
				422,
			);
		}
		if (!Number.isInteger(line.inventoryVersion) || line.inventoryVersion < 0) {
			throw new PluginRouteError(
				"VALIDATION_ERROR",
				"Line item inventory version must be a non-negative integer",
				422,
			);
		}
		if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
			throw new PluginRouteError(
				"VALIDATION_ERROR",
				"Line item unit price must be a non-negative integer",
				422,
			);
		}
	}

	// --- Persist ---
	let ownerToken: string | undefined;
	let ownerTokenHash: string | undefined;

	if (!existing) {
		// First creation: issue a fresh owner token.
		ownerToken = randomFinalizeTokenHex(24);
		ownerTokenHash = sha256Hex(ownerToken);
	} else {
		// Preserve existing ownership.
		ownerTokenHash = existing.ownerTokenHash;
	}

	const cart: StoredCart = {
		currency: ctx.input.currency,
		lineItems: ctx.input.lineItems.map((l) => ({
			productId: l.productId,
			variantId: l.variantId,
			quantity: l.quantity,
			inventoryVersion: l.inventoryVersion,
			unitPriceMinor: l.unitPriceMinor,
		})),
		ownerTokenHash,
		createdAt: existing?.createdAt ?? nowIso,
		updatedAt: nowIso,
	};

	await carts.put(ctx.input.cartId, cart);

	const response: CartUpsertResponse = {
		cartId: ctx.input.cartId,
		currency: cart.currency,
		lineItemCount: cart.lineItems.length,
		updatedAt: cart.updatedAt,
	};
	if (ownerToken) {
		response.ownerToken = ownerToken;
	}
	return response;
}

// ---------------------------------------------------------------------------
// cart/get
// ---------------------------------------------------------------------------

export type CartGetResponse = {
	cartId: string;
	currency: string;
	lineItems: StoredCart["lineItems"];
	createdAt: string;
	updatedAt: string;
};

export async function cartGetHandler(ctx: RouteContext<CartGetInput>): Promise<CartGetResponse> {
	requirePost(ctx);

	const carts = asCollection<StoredCart>(ctx.storage.carts);
	const cart = await carts.get(ctx.input.cartId);

	if (!cart) {
		throwCommerceApiError({ code: "CART_NOT_FOUND", message: "Cart not found" });
	}

	return {
		cartId: ctx.input.cartId,
		currency: cart.currency,
		lineItems: cart.lineItems,
		createdAt: cart.createdAt,
		updatedAt: cart.updatedAt,
	};
}
