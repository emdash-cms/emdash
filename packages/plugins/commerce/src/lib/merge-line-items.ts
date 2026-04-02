/**
 * Merge duplicate SKU rows so inventory finalize applies one decrement per (productId, variantId).
 * Duplicate lines must share the same snapshot version and unit price (enforced at checkout).
 */

export type MergeableLine = {
	productId: string;
	variantId?: string;
	quantity: number;
	inventoryVersion: number;
	unitPriceMinor: number;
};

function lineKey(line: MergeableLine): string {
	return `${line.productId}\u0000${line.variantId ?? ""}`;
}

export function mergeLineItemsBySku<T extends MergeableLine>(lines: T[]): T[] {
	const map = new Map<string, T>();
	for (const line of lines) {
		const k = lineKey(line);
		const cur = map.get(k);
		if (!cur) {
			map.set(k, { ...line });
			continue;
		}
		if (cur.inventoryVersion !== line.inventoryVersion) {
			throw new Error(
				`mergeLineItemsBySku: conflicting inventoryVersion for ${line.productId}/${line.variantId ?? ""}`,
			);
		}
		if (cur.unitPriceMinor !== line.unitPriceMinor) {
			throw new Error(
				`mergeLineItemsBySku: conflicting unitPriceMinor for ${line.productId}/${line.variantId ?? ""}`,
			);
		}
		map.set(k, { ...cur, quantity: cur.quantity + line.quantity });
	}
	return [...map.values()];
}
