import { equalSha256HexDigestAsync, sha256HexAsync } from "../lib/crypto-adapter.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { StoredCart } from "../types.js";

export type CartOwnerTokenOperation = "read" | "mutate" | "checkout";

/**
 * The raw `ownerToken` must be presented and match `ownerTokenHash` for all carts.
 */
export async function assertCartOwnerToken(
	cart: StoredCart,
	ownerToken: string | undefined,
	op: CartOwnerTokenOperation,
): Promise<void> {
	if (!cart.ownerTokenHash) {
		throwCommerceApiError({
			code: "CART_TOKEN_REQUIRED",
			message: "Cart ownership token is required but not configured",
		});
	}

	const presented = ownerToken?.trim();
	if (!presented) {
		const messages: Record<CartOwnerTokenOperation, string> = {
			read: "An owner token is required to read this cart",
			mutate: "An owner token is required to modify this cart",
			checkout: "An owner token is required to check out this cart",
		};
		throwCommerceApiError({
			code: "CART_TOKEN_REQUIRED",
			message: messages[op],
		});
	}
	const presentedHash = await sha256HexAsync(presented);
	if (!(await equalSha256HexDigestAsync(presentedHash, cart.ownerTokenHash))) {
		throwCommerceApiError({
			code: "CART_TOKEN_INVALID",
			message: "Owner token is invalid",
		});
	}
}
