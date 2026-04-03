/**
 * Stable fingerprint of cart sellable content for idempotency scoping.
 * Any change to lines, versions, qty, or prices yields a different hash.
 */

import type { CartLineItem } from "../types.js";
import { sha256Hex } from "../hash.js";
import { projectCartLineItemsForFingerprint } from "./cart-lines.js";

export function cartContentFingerprint(lines: CartLineItem[]): string {
	const normalized = projectCartLineItemsForFingerprint(lines);
	return sha256Hex(JSON.stringify(normalized));
}
