/**
 * Validates that cart/checkout line items have sufficient stock using the same
 * ownership model as finalization: bundle products use component SKU stock only;
 * no bundle-owned inventory row is required.
 */

import { inventoryStockDocId } from "./inventory-stock.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { StoredBundleComponent, StoredInventoryStock, StoredProduct, StoredProductSku } from "../types.js";

type GetCollection<T> = { get(id: string): Promise<T | null> };

type QueryBundleComponents = {
	query(options?: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string; data: StoredBundleComponent }>; hasMore: boolean }>;
};

export type CheckoutInventoryValidationPorts = {
	products: GetCollection<StoredProduct>;
	bundleComponents: QueryBundleComponents;
	productSkus: GetCollection<StoredProductSku>;
	inventoryStock: GetCollection<StoredInventoryStock>;
};

type LineLike = {
	productId: string;
	variantId?: string;
	quantity: number;
};

export async function validateLineItemsStockForCheckout(
	lines: ReadonlyArray<LineLike>,
	ports: CheckoutInventoryValidationPorts,
): Promise<void> {
	for (const line of lines) {
		const product = await ports.products.get(line.productId);
		if (!product) {
			throwCommerceApiError({
				code: "PRODUCT_UNAVAILABLE",
				message: `Product is not available: ${line.productId}`,
			});
		}

		if (product.type === "bundle") {
			const componentRows = await ports.bundleComponents.query({
				where: { bundleProductId: line.productId },
			});
			if (componentRows.items.length === 0) {
				throwCommerceApiError({
					code: "PRODUCT_UNAVAILABLE",
					message: `Bundle has no components: ${line.productId}`,
				});
			}
			for (const row of componentRows.items) {
				const component = row.data;
				const sku = await ports.productSkus.get(component.componentSkuId);
				if (!sku) {
					throwCommerceApiError({
						code: "PRODUCT_UNAVAILABLE",
						message: `Bundle component SKU missing: ${component.componentSkuId}`,
					});
				}
				const need = Math.max(1, component.quantity) * line.quantity;
				const stockId = inventoryStockDocId(sku.productId, sku.id);
				const inv = await ports.inventoryStock.get(stockId);
				if (!inv) {
					throwCommerceApiError({
						code: "PRODUCT_UNAVAILABLE",
						message: `Product is not available: ${sku.productId}`,
					});
				}
				if (inv.quantity < need) {
					throwCommerceApiError({
						code: "INSUFFICIENT_STOCK",
						message: `Insufficient stock for product ${sku.productId}`,
					});
				}
			}
			continue;
		}

		const stockId = inventoryStockDocId(line.productId, line.variantId ?? "");
		const inv = await ports.inventoryStock.get(stockId);
		if (!inv) {
			throwCommerceApiError({
				code: "PRODUCT_UNAVAILABLE",
				message: `Product is not available: ${line.productId}`,
			});
		}
		if (inv.quantity < line.quantity) {
			throwCommerceApiError({
				code: "INSUFFICIENT_STOCK",
				message: `Insufficient stock for product ${line.productId}`,
			});
		}
	}
}
