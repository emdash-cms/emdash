import { equalSha256HexDigest, sha256Hex } from "../hash.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { StoredCart } from "../types.js";

export type CartOwnerTokenOperation = "read" | "mutate";

/**
 * When `ownerTokenHash` is set, the raw `ownerToken` must be presented and match.
 * Legacy carts without a hash skip this check (readable/mutable until migrated).
 */
export function assertCartOwnerToken(
	cart: StoredCart,
	ownerToken: string | undefined,
	op: CartOwnerTokenOperation,
): void {
	if (!cart.ownerTokenHash) return;

	const presented = ownerToken?.trim();
	if (!presented) {
		throwCommerceApiError({
			code: "CART_TOKEN_REQUIRED",
			message:
				op === "read"
					? "An owner token is required to read this cart"
					: "An owner token is required to modify this cart",
		});
	}
	const presentedHash = sha256Hex(presented);
	if (!equalSha256HexDigest(presentedHash, cart.ownerTokenHash)) {
		throwCommerceApiError({
			code: "CART_TOKEN_INVALID",
			message: "Owner token is invalid",
		});
	}
}
