/**
 * Cart handlers: upsert and get.
 *
 * Ownership model
 * ---------------
 * On first creation the server issues an opaque `ownerToken` (random hex, 24 bytes).
 * Only the SHA-256 hash is stored on the cart document (`ownerTokenHash`).
 * The raw token is returned once in the creation response and must be presented
 * by the caller on all subsequent reads (`cart/get`) and mutations (`cart/upsert`).
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

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { projectCartLineItemsForStorage } from "../lib/cart-lines.js";
import { assertCartOwnerToken } from "../lib/cart-owner-token.js";
import { validateCartLineItems } from "../lib/cart-validation.js";
import { randomHex, sha256HexAsync } from "../lib/crypto-adapter.js";
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
	 * Present on first creation and returned when a legacy cart is migrated.
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
	let ownerToken: string | undefined;
	let ownerTokenHash: string | undefined = existing?.ownerTokenHash;

	if (existing) {
		await assertCartOwnerToken(existing, ctx.input.ownerToken, "mutate");
	}

	// --- Legacy migration ---
	// Existing carts without an ownerTokenHash are legacy carts; this migration
	// binds future mutations to an owner token, either provided by the caller or
	// generated and returned.
	const isLegacy = existing !== null && existing.ownerTokenHash === undefined;
	const rateLimitByCartId = !existing || (isLegacy && !ctx.input.ownerToken);
	if (!existing) {
		ownerToken = randomHex(24);
		ownerTokenHash = await sha256HexAsync(ownerToken);
	} else if (isLegacy) {
		if (ctx.input.ownerToken) {
			ownerTokenHash = await sha256HexAsync(ctx.input.ownerToken);
		} else {
			ownerToken = randomHex(24);
			ownerTokenHash = await sha256HexAsync(ownerToken);
		}
	}

	// --- Rate limit: keyed by cartId for first-time/new carts, token hash thereafter ---
	const cartIdHash = await sha256HexAsync(ctx.input.cartId);
	const rateLimitKey = rateLimitByCartId
		? `cart:id:${cartIdHash.slice(0, 32)}`
		: `cart:token:${ownerTokenHash!.slice(0, 32)}`;

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
	const lineItemValidationMessage = validateCartLineItems(ctx.input.lineItems);
	if (lineItemValidationMessage) {
		throw PluginRouteError.badRequest(lineItemValidationMessage);
	}

	// --- Persist ---
	const cart: StoredCart = {
		currency: ctx.input.currency,
		lineItems: projectCartLineItemsForStorage(ctx.input.lineItems),
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

	await assertCartOwnerToken(cart, ctx.input.ownerToken, "read");

	return {
		cartId: ctx.input.cartId,
		currency: cart.currency,
		lineItems: cart.lineItems,
		createdAt: cart.createdAt,
		updatedAt: cart.updatedAt,
	};
}
