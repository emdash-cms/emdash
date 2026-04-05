/**
 * Expands order lines for inventory preflight and mutation: bundle lines become
 * one row per component SKU (quantity × bundles). Non-bundle lines pass through.
 * Duplicate component SKUs are merged after expansion via {@link mergeLineItemsBySku}.
 *
 * Bundle expansion runs only when the order snapshot includes non-negative
 * `componentInventoryVersion` for every component (captured at checkout).
 * Otherwise the line is treated like a legacy bundle row keyed by bundle `productId`.
 */

import { mergeLineItemsBySku } from "./merge-line-items.js";
import type { OrderLineItem } from "../types.js";

function shouldExpandBundleLine(line: OrderLineItem): boolean {
	const snap = line.snapshot;
	const bundle = snap?.bundleSummary;
	if (snap?.productType !== "bundle" || !bundle?.components || bundle.components.length === 0) {
		return false;
	}
	return bundle.components.every((c) => c.componentInventoryVersion >= 0);
}

/**
 * Merge cart/order lines, expand bundles to component SKUs, merge again so the
 * same component requested by multiple bundle lines is decremented once.
 */
export function toInventoryDeductionLines(lines: ReadonlyArray<OrderLineItem>): OrderLineItem[] {
	const mergedBundles = mergeLineItemsBySku([...lines]);
	const expanded: OrderLineItem[] = [];
	for (const line of mergedBundles) {
		if (shouldExpandBundleLine(line)) {
			const bundle = line.snapshot!.bundleSummary!;
			for (const comp of bundle.components) {
				const qty = comp.quantityPerBundle * line.quantity;
				expanded.push({
					productId: comp.componentProductId,
					variantId: comp.componentSkuId,
					quantity: qty,
					inventoryVersion: comp.componentInventoryVersion,
					unitPriceMinor: comp.componentPriceMinor,
				});
			}
		} else {
			expanded.push(line);
		}
	}
	return mergeLineItemsBySku(expanded);
}
