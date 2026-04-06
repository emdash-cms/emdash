/**
 * Expands order lines for inventory preflight and mutation: bundle lines become
 * one row per component SKU (quantity × bundles). Non-bundle lines pass through.
 * Duplicate component SKUs are merged after expansion via {@link mergeLineItemsBySku}.
 */

import { mergeLineItemsBySku } from "./merge-line-items.js";
import type { OrderLineItem } from "../types.js";

function expandBundleLineToComponents(line: OrderLineItem): OrderLineItem[] {
	const bundle = line.snapshot?.bundleSummary;
	if (!bundle || bundle.components.length === 0) {
		throw new Error(`Bundle snapshot is incomplete for product ${line.productId}`);
	}

	for (const component of bundle.components) {
		if (!Number.isFinite(component.componentInventoryVersion) || component.componentInventoryVersion < 0) {
			throw new Error(
				`Bundle snapshot missing component inventory version for product ${line.productId} component ${component.componentId}`,
			);
		}
	}

	return bundle.components.map((component) => ({
		productId: component.componentProductId,
		variantId: component.componentSkuId,
		quantity: component.quantityPerBundle * line.quantity,
		inventoryVersion: component.componentInventoryVersion,
		unitPriceMinor: component.componentPriceMinor,
	}));
}

/**
 * Merge cart/order lines, expand bundles to component SKUs, merge again so the
 * same component requested by multiple bundle lines is decremented once.
 */
export function toInventoryDeductionLines(lines: ReadonlyArray<OrderLineItem>): OrderLineItem[] {
	const mergedBundles = mergeLineItemsBySku([...lines]);
	const expanded: OrderLineItem[] = [];
	for (const line of mergedBundles) {
		if (line.snapshot?.productType === "bundle") {
			expanded.push(...expandBundleLineToComponents(line));
		} else {
			expanded.push(line);
		}
	}
	return mergeLineItemsBySku(expanded);
}
