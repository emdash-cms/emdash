export function inventoryStockDocId(productId: string, variantId: string): string {
	return `stock:${encodeURIComponent(productId)}:${encodeURIComponent(variantId)}`;
}
