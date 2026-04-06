import type { BundleDiscountType, StoredBundleComponent, StoredProductSku } from "../types.js";

export type BundleComputeComponentSummary = {
	componentId: string;
	componentSkuId: string;
	componentSkuCode: string;
	componentProductId: string;
	componentPriceMinor: number;
	quantityPerBundle: number;
	subtotalContributionMinor: number;
	availableBundleQuantity: number;
};

export type BundleComputeSummary = {
	productId: string;
	subtotalMinor: number;
	discountType: BundleDiscountType;
	discountValueMinor: number;
	discountValueBps: number;
	discountAmountMinor: number;
	finalPriceMinor: number;
	availability: number;
	components: BundleComputeComponentSummary[];
};

export type BundleComputeInputLine = {
	component: StoredBundleComponent;
	sku: StoredProductSku;
};

export function computeBundleSummary(
	productId: string,
	discountType: BundleDiscountType | undefined,
	discountValueMinor: number | undefined,
	discountValueBps: number | undefined,
	lines: BundleComputeInputLine[],
): BundleComputeSummary {
	const type: BundleDiscountType = discountType ?? "none";
	const resolvedDiscountValueMinor = Math.max(0, discountValueMinor ?? 0);
	const resolvedDiscountValueBps = Math.min(10_000, Math.max(0, discountValueBps ?? 0));

	const summaryLines: BundleComputeComponentSummary[] = lines.map((line) => {
		const qty = Math.max(1, line.component.quantity);
		const componentAvailable =
			line.sku.status !== "active" ? 0 : Math.floor(line.sku.inventoryQuantity / qty);
		return {
			componentId: line.component.id,
			componentSkuId: line.component.componentSkuId,
			componentSkuCode: line.sku.skuCode,
			componentProductId: line.sku.productId,
			componentPriceMinor: line.sku.unitPriceMinor,
			quantityPerBundle: line.component.quantity,
			subtotalContributionMinor: line.sku.unitPriceMinor * line.component.quantity,
			availableBundleQuantity: componentAvailable,
		};
	});

	const subtotalMinor = summaryLines.reduce((sum, line) => sum + line.subtotalContributionMinor, 0);
	const rawDiscountAmount =
		type === "fixed_amount"
			? resolvedDiscountValueMinor
			: type === "percentage"
				? Math.floor((subtotalMinor * resolvedDiscountValueBps) / 10_000)
				: 0;
	const discountAmountMinor = Math.max(0, Math.min(subtotalMinor, rawDiscountAmount));
	const finalPriceMinor = Math.max(0, subtotalMinor - discountAmountMinor);

	const availability =
		summaryLines.length === 0
			? 0
			: Math.min(...summaryLines.map((line) => line.availableBundleQuantity));

	return {
		productId,
		subtotalMinor,
		discountType: type,
		discountValueMinor: resolvedDiscountValueMinor,
		discountValueBps: resolvedDiscountValueBps,
		discountAmountMinor,
		finalPriceMinor,
		availability,
		components: summaryLines,
	};
}
