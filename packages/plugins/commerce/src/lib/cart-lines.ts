import type { CartLineItem } from "../types.js";
import { sortedImmutable } from "./sort-immutable.js";

export type CanonicalCartLineItem = {
	productId: string;
	variantId?: string;
	quantity: number;
	inventoryVersion: number;
	unitPriceMinor: number;
};

type CartFingerprintLine = {
	productId: string;
	variantId: string;
	quantity: number;
	inventoryVersion: number;
	unitPriceMinor: number;
};

export function projectCartLineItemsForStorage(
	lines: ReadonlyArray<CartLineItem>,
): CanonicalCartLineItem[] {
	return lines.map((line) => ({
		productId: line.productId,
		variantId: line.variantId,
		quantity: line.quantity,
		inventoryVersion: line.inventoryVersion,
		unitPriceMinor: line.unitPriceMinor,
	}));
}

function compareByProductAndVariant(
	left: { productId: string; variantId: string },
	right: { productId: string; variantId: string },
) {
	const productOrder = left.productId.localeCompare(right.productId);
	if (productOrder !== 0) return productOrder;
	return left.variantId.localeCompare(right.variantId);
}

export function projectCartLineItemsForFingerprint(
	lines: ReadonlyArray<CartLineItem>,
): CartFingerprintLine[] {
	const projected = Array.from(lines, (line) => ({
		productId: line.productId,
		variantId: line.variantId ?? "",
		quantity: line.quantity,
		inventoryVersion: line.inventoryVersion,
		unitPriceMinor: line.unitPriceMinor,
	}));
	return sortedImmutable(projected, compareByProductAndVariant);
}
