import { COMMERCE_LIMITS } from "../kernel/limits.js";
import type { CartLineItem } from "../types.js";

export function validateCartLineItems(lines: ReadonlyArray<CartLineItem>): string | null {
	for (const line of lines) {
		if (
			!Number.isInteger(line.quantity) ||
			line.quantity < 1 ||
			line.quantity > COMMERCE_LIMITS.maxLineItemQty
		) {
			return `Line item quantity must be between 1 and ${COMMERCE_LIMITS.maxLineItemQty}`;
		}
		if (!Number.isInteger(line.inventoryVersion) || line.inventoryVersion < 0) {
			return "Line item inventory version must be a non-negative integer";
		}
		if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
			return "Line item unit price must be a non-negative integer";
		}
	}

	return null;
}
