import { computeBundleSummary } from "./catalog-bundles.js";
import { inventoryStockDocId } from "../orchestration/finalize-payment-inventory.js";
import type {
	OrderLineItemBundleComponentSummary,
	OrderLineItemBundleSummary,
	OrderLineItemDigitalEntitlementSnapshot,
	OrderLineItemImageSnapshot,
	OrderLineItemOptionSelection,
	OrderLineItemSnapshot,
	StoredBundleComponent,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredInventoryStock,
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductSku,
	StoredProductSkuOptionValue,
} from "../types.js";

type QueryResult<T> = {
	items: Array<{ id: string; data: T }>;
	hasMore: boolean;
};

type QueryCollection<T> = {
	get(id: string): Promise<T | null>;
	query(options?: { where?: Record<string, unknown>; limit?: number }): Promise<QueryResult<T>>;
};

export type CatalogSnapshotCollections = {
	products: QueryCollection<StoredProduct>;
	productSkus: QueryCollection<StoredProductSku>;
	productSkuOptionValues: QueryCollection<StoredProductSkuOptionValue>;
	productDigitalAssets: QueryCollection<StoredDigitalAsset>;
	productDigitalEntitlements: QueryCollection<StoredDigitalEntitlement>;
	productAssetLinks: QueryCollection<StoredProductAssetLink>;
	productAssets: QueryCollection<StoredProductAsset>;
	bundleComponents: QueryCollection<StoredBundleComponent>;
	/** Required for bundle snapshots: per-component stock versions at checkout. */
	inventoryStock: { get(id: string): Promise<StoredInventoryStock | null> };
};

type SnapshotLineInput = {
	productId: string;
	variantId?: string;
	quantity: number;
	unitPriceMinor: number;
	inventoryVersion: number;
};

export async function buildOrderLineSnapshots(
	lines: ReadonlyArray<SnapshotLineInput>,
	currency: string,
	catalog: CatalogSnapshotCollections,
): Promise<OrderLineItemSnapshot[]> {
	const snapshots = await Promise.all(
		lines.map((line) => buildOrderLineSnapshot(line, currency, catalog)),
	);
	return snapshots;
}

function createFallbackLineSnapshot(line: SnapshotLineInput, currency: string): OrderLineItemSnapshot {
	const lineSubtotalMinor = line.unitPriceMinor * line.quantity;
	return {
		productId: line.productId,
		skuId: line.variantId ?? line.productId,
		productType: "simple",
		productTitle: line.productId,
		skuCode: line.variantId ?? line.productId,
		selectedOptions: [],
		currency,
		unitPriceMinor: line.unitPriceMinor,
		lineSubtotalMinor,
		lineDiscountMinor: 0,
		lineTotalMinor: lineSubtotalMinor,
		requiresShipping: true,
		isDigital: false,
	};
}

async function buildOrderLineSnapshot(
	line: SnapshotLineInput,
	currency: string,
	catalog: CatalogSnapshotCollections,
): Promise<OrderLineItemSnapshot> {
	const product = await catalog.products.get(line.productId);
	if (!product) {
		return createFallbackLineSnapshot(line, currency);
	}

	const base: OrderLineItemSnapshot = {
		productId: product.id,
		productType: product.type,
		productTitle: product.title,
		productSlug: product.slug,
		skuId: line.variantId ?? line.productId,
		skuCode: line.variantId ?? line.productId,
		selectedOptions: [],
		currency,
		unitPriceMinor: line.unitPriceMinor,
		lineSubtotalMinor: line.unitPriceMinor * line.quantity,
		lineDiscountMinor: 0,
		lineTotalMinor: line.unitPriceMinor * line.quantity,
		requiresShipping: true,
		isDigital: false,
	};

	const sku = await resolveSkuForSnapshot(line, product, catalog.productSkus);
	if (sku) {
		base.skuId = sku.id;
		base.skuCode = sku.skuCode;
		base.compareAtPriceMinor = sku.compareAtPriceMinor;
		base.requiresShipping = sku.requiresShipping;
		base.isDigital = sku.isDigital;
		base.unitPriceMinor = sku.unitPriceMinor;
		base.lineSubtotalMinor = sku.unitPriceMinor * line.quantity;
		base.lineTotalMinor = base.lineSubtotalMinor;
		if (product.type === "variable") {
			base.selectedOptions = await querySkuOptionSelections(sku.id, catalog.productSkuOptionValues);
		}
	}

	if (product.type === "bundle") {
		const bundleSummary = await buildBundleSummary(product.id, catalog);
		if (bundleSummary) {
			base.bundleSummary = bundleSummary.summary;
			base.unitPriceMinor = bundleSummary.summary.finalPriceMinor;
			base.lineSubtotalMinor = bundleSummary.summary.subtotalMinor * line.quantity;
			base.lineDiscountMinor = bundleSummary.summary.discountAmountMinor * line.quantity;
			base.lineTotalMinor = bundleSummary.summary.finalPriceMinor * line.quantity;
			base.requiresShipping = bundleSummary.requiresShipping;
		}
	}

	const targetType = line.variantId ? "sku" : "product";
	const targetId = line.variantId ?? product.id;
	const preferredRoles = line.variantId ? ["variant_image", "primary_image"] : ["primary_image"];
	base.image = await queryRepresentativeImage({
		productAssetLinks: catalog.productAssetLinks,
		productAssets: catalog.productAssets,
		targetType,
		targetId,
		roles: preferredRoles,
	});
	if (!base.image && line.variantId) {
		base.image = await queryRepresentativeImage({
			productAssetLinks: catalog.productAssetLinks,
			productAssets: catalog.productAssets,
			targetType: "product",
			targetId: product.id,
			roles: ["primary_image"],
		});
	}

	if (sku) {
		const entitlements = await collectDigitalEntitlements(sku.id, catalog);
		if (entitlements.length > 0) {
			base.digitalEntitlements = entitlements;
		}
	}

	return base;
}

async function resolveSkuForSnapshot(
	line: SnapshotLineInput,
	product: StoredProduct,
	productSkus: QueryCollection<StoredProductSku>,
): Promise<StoredProductSku | null> {
	if (line.variantId) {
		const sku = await productSkus.get(line.variantId);
		if (!sku || sku.productId !== line.productId) {
			return null;
		}
		return sku;
	}

	if (product.type === "variable") {
		return null;
	}

	const rows = await productSkus.query({ where: { productId: line.productId }, limit: 5 });
	if (rows.items.length !== 1) {
		return null;
	}
	return rows.items[0].data;
}

async function buildBundleSummary(
	productId: string,
	catalog: CatalogSnapshotCollections,
): Promise<{ summary: OrderLineItemBundleSummary; requiresShipping: boolean } | undefined> {
	const componentRows = await catalog.bundleComponents.query({ where: { bundleProductId: productId } });
	if (componentRows.items.length === 0) return undefined;

	const componentLines: { component: StoredBundleComponent; sku: StoredProductSku }[] = [];
	for (const row of componentRows.items) {
		const component = row.data;
		const sku = await catalog.productSkus.get(component.componentSkuId);
		if (!sku) continue;
		componentLines.push({ component, sku });
	}
	if (componentLines.length === 0) return undefined;

	const product = await catalog.products.get(productId);
	if (!product) return undefined;

	const summary = computeBundleSummary(
		productId,
		product.bundleDiscountType,
		product.bundleDiscountValueMinor,
		product.bundleDiscountValueBps,
		componentLines.map((entry) => ({
			component: entry.component,
			sku: entry.sku,
		})),
	);
	const components: OrderLineItemBundleComponentSummary[] = await Promise.all(
		summary.components.map(async (component) => {
			const stockId = inventoryStockDocId(component.componentProductId, component.componentSkuId);
			const stock = await catalog.inventoryStock.get(stockId);
			return {
				componentId: component.componentId,
				componentSkuId: component.componentSkuId,
				componentSkuCode: component.componentSkuCode,
				componentProductId: component.componentProductId,
				componentPriceMinor: component.componentPriceMinor,
				quantityPerBundle: component.quantityPerBundle,
				subtotalContributionMinor: component.subtotalContributionMinor,
				availableBundleQuantity: component.availableBundleQuantity,
				componentInventoryVersion: stock?.version ?? -1,
			};
		}),
	);

	const out: OrderLineItemBundleSummary = {
		productId,
		subtotalMinor: summary.subtotalMinor,
		discountType: summary.discountType,
		discountValueMinor: summary.discountValueMinor,
		discountValueBps: summary.discountValueBps,
		discountAmountMinor: summary.discountAmountMinor,
		finalPriceMinor: summary.finalPriceMinor,
		availability: summary.availability,
		components,
	};
	const requiresShipping = componentLines.some((line) => line.sku.requiresShipping);
	return { summary: out, requiresShipping };
}

async function collectDigitalEntitlements(
	skuId: string,
	catalog: CatalogSnapshotCollections,
): Promise<OrderLineItemDigitalEntitlementSnapshot[]> {
	const entitlements = await catalog.productDigitalEntitlements.query({ where: { skuId }, limit: 200 });
	const out: OrderLineItemDigitalEntitlementSnapshot[] = [];
	for (const row of entitlements.items) {
		const entitlement = row.data;
		const asset = await catalog.productDigitalAssets.get(entitlement.digitalAssetId);
		if (!asset) continue;
		out.push({
			entitlementId: entitlement.id,
			digitalAssetId: entitlement.digitalAssetId,
			digitalAssetLabel: asset.label,
			grantedQuantity: entitlement.grantedQuantity,
			downloadLimit: asset.downloadLimit,
			downloadExpiryDays: asset.downloadExpiryDays,
			isManualOnly: asset.isManualOnly,
			isPrivate: asset.isPrivate,
		});
	}
	return out;
}

async function querySkuOptionSelections(
	skuId: string,
	productSkuOptionValues: QueryCollection<StoredProductSkuOptionValue>,
): Promise<OrderLineItemOptionSelection[]> {
	const options = await productSkuOptionValues.query({ where: { skuId } });
	const ordered = options.items
		.map((row) => ({
			attributeId: row.data.attributeId,
			attributeValueId: row.data.attributeValueId,
		}))
		.sort(
			(left, right) =>
				left.attributeId.localeCompare(right.attributeId) ||
				left.attributeValueId.localeCompare(right.attributeValueId),
		);
	return ordered;
}

async function queryRepresentativeImage(input: {
	productAssetLinks: QueryCollection<StoredProductAssetLink>;
	productAssets: QueryCollection<StoredProductAsset>;
	targetType: StoredProductAssetLink["targetType"];
	targetId: string;
	roles: StoredProductAssetLink["role"][];
}): Promise<OrderLineItemImageSnapshot | undefined> {
		const links = await input.productAssetLinks.query({
			where: { targetType: input.targetType, targetId: input.targetId },
		});
	const sorted = links.items
		.map((row) => row.data)
		.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
	const acceptedRoles = new Set(input.roles);
	for (const link of sorted) {
		if (!acceptedRoles.has(link.role)) continue;
		const asset = await input.productAssets.get(link.assetId);
		if (!asset) continue;
		return {
			linkId: link.id,
			assetId: asset.id,
			provider: asset.provider,
			externalAssetId: asset.externalAssetId,
			fileName: asset.fileName,
			altText: asset.altText,
		};
	}
	return undefined;
}

