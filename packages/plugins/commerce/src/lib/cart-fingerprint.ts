/**
 * Stable fingerprint of cart sellable content for idempotency scoping.
 * Any change to lines, versions, qty, or prices yields a different hash.
 */

import type { CartLineItem } from "../types.js";
import { sha256Hex } from "../hash.js";

export function cartContentFingerprint(lines: CartLineItem[]): string {
	const normalized = Array.from(lines, (l) => ({
			productId: l.productId,
			variantId: l.variantId ?? "",
			quantity: l.quantity,
			inventoryVersion: l.inventoryVersion,
			unitPriceMinor: l.unitPriceMinor,
	})).toSorted((a, b) => {
		const pk = a.productId.localeCompare(b.productId);
		if (pk !== 0) return pk;
		return a.variantId.localeCompare(b.variantId);
	});
	return sha256Hex(JSON.stringify(normalized));
}
