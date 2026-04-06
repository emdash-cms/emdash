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

export class LineConflictError extends Error {
	constructor(
		message: string,
		public readonly productId: string,
		public readonly variantId: string | undefined,
		public readonly expected: { inventoryVersion: number; unitPriceMinor: number },
		public readonly actual: { inventoryVersion: number; unitPriceMinor: number },
	) {
		super(message);
		this.name = "LineConflictError";
	}
}

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
			throw new LineConflictError(
				`mergeLineItemsBySku: conflicting inventoryVersion for ${line.productId}/${line.variantId ?? ""}`,
				line.productId,
				line.variantId,
				{ inventoryVersion: cur.inventoryVersion, unitPriceMinor: cur.unitPriceMinor },
				{ inventoryVersion: line.inventoryVersion, unitPriceMinor: line.unitPriceMinor },
			);
		}
		if (cur.unitPriceMinor !== line.unitPriceMinor) {
			throw new LineConflictError(
				`mergeLineItemsBySku: conflicting unitPriceMinor for ${line.productId}/${line.variantId ?? ""}`,
				line.productId,
				line.variantId,
				{ inventoryVersion: cur.inventoryVersion, unitPriceMinor: cur.unitPriceMinor },
				{ inventoryVersion: line.inventoryVersion, unitPriceMinor: line.unitPriceMinor },
			);
		}
		map.set(k, { ...cur, quantity: cur.quantity + line.quantity });
	}
	return [...map.values()];
}
