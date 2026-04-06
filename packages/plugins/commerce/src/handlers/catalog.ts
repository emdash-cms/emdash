/**
 * Catalog management handlers for commerce plugin v1 foundation.
 *
 * This file implements the Phase 1 foundation slice from the catalog
 * specification: products and product SKUs with basic write/read paths and
 * invariant checks for unique product slug / SKU code.
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import {
	applyProductUpdatePatch,
	applyProductSkuUpdatePatch,
} from "../lib/catalog-domain.js";
import {
	collectVariantDefiningAttributes,
	normalizeSkuOptionSignature,
	validateVariableSkuOptions,
} from "../lib/catalog-variants.js";
import { inventoryStockDocId } from "../lib/inventory-stock.js";
import type {
	CatalogListingDTO,
	ProductCategoryDTO,
	ProductDetailDTO,
	ProductDigitalEntitlementSummary,
	ProductInventorySummaryDTO,
	ProductPrimaryImageDTO,
	ProductPriceRangeDTO,
	ProductTagDTO,
	VariantMatrixDTO,
} from "../lib/catalog-dto.js";
import {
	type BundleComputeSummary,
	computeBundleSummary,
} from "../lib/catalog-bundles.js";
import { randomHex } from "../lib/crypto-adapter.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { sortedImmutable } from "../lib/sort-immutable.js";
import type {
	ProductCreateInput,
	ProductAssetLinkInput,
	ProductAssetReorderInput,
	ProductAssetRegisterInput,
	ProductAssetUnlinkInput,
	ProductSkuStateInput,
	ProductSkuUpdateInput,
	ProductGetInput,
	ProductListInput,
	ProductSkuCreateInput,
	DigitalAssetCreateInput,
	DigitalEntitlementCreateInput,
	DigitalEntitlementRemoveInput,
	BundleComponentAddInput,
	BundleComponentRemoveInput,
	BundleComponentReorderInput,
	BundleComputeInput,
	ProductStateInput,
	ProductUpdateInput,
	ProductSkuListInput,
	CategoryCreateInput,
	CategoryListInput,
	ProductCategoryLinkInput,
	ProductCategoryUnlinkInput,
	TagCreateInput,
	TagListInput,
	ProductTagLinkInput,
	ProductTagUnlinkInput,
} from "../schemas.js";
import type {
	ProductAssetLinkTarget,
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductAttribute,
	StoredProductAttributeValue,
	StoredCategory,
	StoredProductCategoryLink,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredProductTag,
	StoredProductTagLink,
	StoredBundleComponent,
	StoredInventoryStock,
	StoredProductSkuOptionValue,
	ProductAssetRole,
	StoredProductSku,
} from "../types.js";
type BundleDiscountPatchInput = {
	bundleDiscountType?: "none" | "fixed_amount" | "percentage";
	bundleDiscountValueMinor?: number;
	bundleDiscountValueBps?: number;
};

function assertBundleDiscountPatchForProduct(
	product: StoredProduct,
	patch: BundleDiscountPatchInput,
): void {
	const hasType = patch.bundleDiscountType !== undefined;
	const hasMinorValue = patch.bundleDiscountValueMinor !== undefined;
	const hasBpsValue = patch.bundleDiscountValueBps !== undefined;
	const effectiveType = patch.bundleDiscountType ?? product.bundleDiscountType ?? "none";

	if (product.type !== "bundle" && (hasType || hasMinorValue || hasBpsValue)) {
		throw PluginRouteError.badRequest("Bundle discount fields are only supported for bundle products");
	}

	if (product.type !== "bundle") {
		return;
	}

	if (hasMinorValue && effectiveType !== "fixed_amount") {
		throw PluginRouteError.badRequest("bundleDiscountValueMinor can only be used with fixed_amount bundles");
	}
	if (hasBpsValue && effectiveType !== "percentage") {
		throw PluginRouteError.badRequest("bundleDiscountValueBps can only be used with percentage bundles");
	}
}

function assertSimpleProductSkuCapacity(product: StoredProduct, existingSkuCount: number): void {
	if (product.type !== "simple") {
		return;
	}
	if (existingSkuCount > 0) {
		throw PluginRouteError.badRequest("Simple products can have at most one SKU");
	}
}

type Collection<T> = StorageCollection<T>;

function asOptionalCollection<T>(raw: unknown): Collection<T> | null {
	return raw ? (raw as Collection<T>) : null;
}

function mapInventoryStockToSku(
	sku: StoredProductSku,
	inventoryStock?: StoredInventoryStock | null,
): StoredProductSku {
	if (!inventoryStock) {
		return sku;
	}
	return {
		...sku,
		inventoryQuantity: inventoryStock.quantity,
		inventoryVersion: inventoryStock.version,
	};
}

async function hydrateSkusWithInventoryStock(
	product: StoredProduct,
	skuRows: StoredProductSku[],
	inventoryStock: Collection<StoredInventoryStock> | null,
): Promise<StoredProductSku[]> {
	if (!inventoryStock) {
		return skuRows;
	}

	const variantStocks = await Promise.all(
		skuRows.map((sku) => inventoryStock.get(inventoryStockDocId(product.id, sku.id))),
	);
	const productLevelStock = product.type === "simple" && skuRows.length === 1
		? await inventoryStock.get(inventoryStockDocId(product.id, ""))
		: null;

	const hydrated = skuRows.map((sku, index) => {
		const stock = variantStocks[index] ?? productLevelStock;
		return mapInventoryStockToSku(sku, stock);
	});
	return hydrated;
}

async function syncInventoryStockForSku(
	inventoryStock: Collection<StoredInventoryStock> | null,
	product: StoredProduct,
	sku: StoredProductSku,
	nowIso: string,
	includeProductLevelStock: boolean,
): Promise<void> {
	if (!inventoryStock) {
		return;
	}

	await inventoryStock.put(inventoryStockDocId(product.id, sku.id), {
		productId: product.id,
		variantId: sku.id,
		quantity: sku.inventoryQuantity,
		version: sku.inventoryVersion,
		updatedAt: nowIso,
	});

	if (!includeProductLevelStock) {
		return;
	}

	await inventoryStock.put(inventoryStockDocId(product.id, ""), {
		productId: product.id,
		variantId: "",
		quantity: sku.inventoryQuantity,
		version: sku.inventoryVersion,
		updatedAt: nowIso,
	});
}

function asCollection<T>(raw: unknown): Collection<T> {
	return raw as Collection<T>;
}

function toWhere(input: { type?: string; status?: string; visibility?: string }) {
	const where: Record<string, string> = {};
	if (input.type) where.type = input.type;
	if (input.status) where.status = input.status;
	if (input.visibility) where.visibility = input.visibility;
	return where;
}

function toUniqueStringList(values: string[]): string[] {
	return [...new Set(values)];
}

async function getManyByIds<T>(collection: Collection<T>, ids: string[]): Promise<Map<string, T>> {
	const uniqueIds = toUniqueStringList(ids);
	const getMany = (collection as { getMany?: (ids: string[]) => Promise<Map<string, T>> }).getMany;
	if (getMany) {
		return getMany.call(collection, uniqueIds);
	}

	const rows = await Promise.all(uniqueIds.map((id) => collection.get(id)));
	const map = new Map<string, T>();
	for (const [index, id] of uniqueIds.entries()) {
		const row = rows[index];
		if (row) {
			map.set(id, row);
		}
	}
	return map;
}

export type ProductSkuResponse = {
	sku: StoredProductSku;
};

export type ProductSkuListResponse = {
	items: StoredProductSku[];
};

export type ProductResponse = Omit<ProductDetailDTO, "skus" | "categories" | "tags"> & {
	skus?: ProductDetailDTO["skus"];
	categories?: ProductDetailDTO["categories"];
	tags?: ProductDetailDTO["tags"];
};

export type ProductAssetResponse = {
	asset: StoredProductAsset;
};

export type ProductAssetLinkResponse = {
	link: StoredProductAssetLink;
};

export type ProductAssetUnlinkResponse = {
	deleted: boolean;
};

export type DigitalAssetResponse = {
	asset: StoredDigitalAsset;
};

export type DigitalEntitlementResponse = {
	entitlement: StoredDigitalEntitlement;
};

export type DigitalEntitlementUnlinkResponse = {
	deleted: boolean;
};

export type BundleComponentResponse = {
	component: StoredBundleComponent;
};

export type BundleComponentUnlinkResponse = {
	deleted: boolean;
};

export type BundleComputeResponse = BundleComputeSummary;

export type ProductListResponse = {
	items: CatalogListingDTO[];
};

export type CategoryResponse = {
	category: StoredCategory;
};

export type CategoryListResponse = {
	items: StoredCategory[];
};

export type ProductCategoryLinkResponse = {
	link: StoredProductCategoryLink;
};

export type ProductCategoryLinkUnlinkResponse = {
	deleted: boolean;
};

export type TagResponse = {
	tag: StoredProductTag;
};

export type TagListResponse = {
	items: StoredProductTag[];
};

export type ProductTagLinkResponse = {
	link: StoredProductTagLink;
};

export type ProductTagLinkUnlinkResponse = {
	deleted: boolean;
};

function sortOrderedRowsByPosition<T extends { createdAt?: string; position: number }>(rows: T[]): T[] {
	const sorted = sortedImmutable(rows, (left, right) => {
		if (left.position === right.position) {
			return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
		}
		return left.position - right.position;
	});
	return sorted;
}

type OrderedRow = {
	id: string;
	position: number;
};

function normalizeOrderedPosition(input: number): number {
	return Math.max(0, Math.trunc(input));
}

function normalizeOrderedChildren<T extends OrderedRow>(rows: T[]): T[] {
	return rows.map((row, idx) => ({
		...row,
		position: idx,
	}));
}

function addOrderedRow<T extends OrderedRow>(rows: T[], row: T, requestedPosition: number): T[] {
	const normalizedPosition = Math.min(normalizeOrderedPosition(requestedPosition), rows.length);
	const nextOrder = [...rows];
	nextOrder.splice(normalizedPosition, 0, row);
	return normalizeOrderedChildren(nextOrder);
}

function removeOrderedRow<T extends OrderedRow>(rows: T[], removedRowId: string): T[] {
	return normalizeOrderedChildren(rows.filter((row) => row.id !== removedRowId));
}

function moveOrderedRow<T extends OrderedRow>(rows: T[], rowId: string, requestedPosition: number): T[] {
	const fromIndex = rows.findIndex((row) => row.id === rowId);
	if (fromIndex === -1) {
		throw PluginRouteError.badRequest("Ordered row not found in target list");
	}

	const nextOrder = [...rows];
	const [moving] = nextOrder.splice(fromIndex, 1);
	if (!moving) {
		throw PluginRouteError.badRequest("Ordered row not found in target list");
	}

	const insertionIndex = Math.min(normalizeOrderedPosition(requestedPosition), rows.length - 1);
	nextOrder.splice(insertionIndex, 0, moving);
	return normalizeOrderedChildren(nextOrder);
}

async function persistOrderedRows<T extends OrderedRow>(
	collection: Collection<T>,
	rows: T[],
	nowIso: string,
): Promise<T[]> {
	const normalized = normalizeOrderedChildren(rows).map((row) => ({
		...row,
		updatedAt: nowIso,
	}));
	for (const row of normalized) {
		await collection.put(row.id, row);
	}
	return normalized;
}

type OrderedChildMutation<T extends OrderedRow> =
	| { kind: "add"; row: T; requestedPosition: number }
	| { kind: "remove"; removedRowId: string }
	| {
		kind: "move";
		rowId: string;
		requestedPosition: number;
		notFoundMessage?: string;
	};

async function mutateOrderedChildren<T extends OrderedRow>(params: {
	collection: Collection<T>;
	rows: T[];
	mutation: OrderedChildMutation<T>;
	nowIso: string;
}): Promise<T[]> {
	const { collection, rows, mutation, nowIso } = params;
	const normalized = (() => {
		switch (mutation.kind) {
			case "add":
				return addOrderedRow(rows, mutation.row, mutation.requestedPosition);
			case "remove":
				return removeOrderedRow(rows, mutation.removedRowId);
			case "move": {
				const { rowId, requestedPosition } = mutation;
				const fromIndex = rows.findIndex((candidate) => candidate.id === rowId);
				if (fromIndex === -1) {
					throw PluginRouteError.badRequest(mutation.notFoundMessage ?? "Ordered row not found in target list");
				}
				return moveOrderedRow(rows, rowId, requestedPosition);
			}
		}
	})();
	return persistOrderedRows(collection, normalized, nowIso);
}

async function queryBundleComponentsForProduct(
	bundleComponents: Collection<StoredBundleComponent>,
	bundleProductId: string,
): Promise<StoredBundleComponent[]> {
	const query = await bundleComponents.query({
		where: { bundleProductId },
	});
	const rows = sortOrderedRowsByPosition(query.items.map((row) => row.data));
	return normalizeOrderedChildren(rows);
}

function toProductCategoryDTO(row: StoredCategory): ProductCategoryDTO {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		parentId: row.parentId,
		position: row.position,
	};
}

function toProductTagDTO(row: StoredProductTag): ProductTagDTO {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
	};
}

async function queryCategoryDtosForProducts(
	productCategoryLinks: Collection<StoredProductCategoryLink>,
	categories: Collection<StoredCategory>,
	productIds: string[],
): Promise<Map<string, ProductCategoryDTO[]>> {
	const normalizedProductIds = toUniqueStringList(productIds);
	if (normalizedProductIds.length === 0) {
		return new Map();
	}

	const links = await productCategoryLinks.query({
		where: { productId: { in: normalizedProductIds } },
	});
	const categoryRows = await getManyByIds(
		categories,
		toUniqueStringList(links.items.map((link) => link.data.categoryId)),
	);
	const rowsByProduct = new Map<string, ProductCategoryDTO[]>();

	for (const link of links.items) {
		const category = categoryRows.get(link.data.categoryId);
		if (!category) {
			continue;
		}
		const current = rowsByProduct.get(link.data.productId) ?? [];
		current.push(toProductCategoryDTO(category));
		rowsByProduct.set(link.data.productId, current);
	}
	return rowsByProduct;
}

async function queryTagDtosForProducts(
	productTagLinks: Collection<StoredProductTagLink>,
	tags: Collection<StoredProductTag>,
	productIds: string[],
): Promise<Map<string, ProductTagDTO[]>> {
	const normalizedProductIds = toUniqueStringList(productIds);
	if (normalizedProductIds.length === 0) {
		return new Map();
	}

	const links = await productTagLinks.query({
		where: { productId: { in: normalizedProductIds } },
	});
	const tagRows = await getManyByIds(tags, toUniqueStringList(links.items.map((link) => link.data.tagId)));
	const rowsByProduct = new Map<string, ProductTagDTO[]>();

	for (const link of links.items) {
		const tag = tagRows.get(link.data.tagId);
		if (!tag) {
			continue;
		}
		const current = rowsByProduct.get(link.data.productId) ?? [];
		current.push(toProductTagDTO(tag));
		rowsByProduct.set(link.data.productId, current);
	}
	return rowsByProduct;
}

function summarizeInventory(skus: StoredProductSku[]): ProductInventorySummaryDTO {
	const skuCount = skus.length;
	const activeSkus = skus.filter((sku) => sku.status === "active");
	const activeSkuCount = activeSkus.length;
	const totalInventoryQuantity = skus.reduce((total, sku) => total + sku.inventoryQuantity, 0);
	return { skuCount, activeSkuCount, totalInventoryQuantity };
}

type ProductReadCollections = {
	productCategoryLinks: Collection<StoredProductCategoryLink>;
	productCategories: Collection<StoredCategory>;
	productTagLinks: Collection<StoredProductTagLink>;
	productTags: Collection<StoredProductTag>;
	productAssets: Collection<StoredProductAsset>;
	productAssetLinks: Collection<StoredProductAssetLink>;
	productSkus: Collection<StoredProductSku>;
	inventoryStock: Collection<StoredInventoryStock> | null;
};

type ProductReadContext = {
	product: StoredProduct;
	includeGalleryImages?: boolean;
};

type ProductReadMetadata = {
	skus: StoredProductSku[];
	categories: ProductCategoryDTO[];
	tags: ProductTagDTO[];
	primaryImage?: ProductPrimaryImageDTO;
	galleryImages: ProductPrimaryImageDTO[];
};

async function loadProductReadMetadata(
	collections: ProductReadCollections,
	context: ProductReadContext,
): Promise<ProductReadMetadata> {
	const { product, includeGalleryImages = false } = context;
	const metadataByProduct = await loadProductsReadMetadata(collections, {
		products: [product],
		includeGalleryImages,
	});
	return metadataByProduct.get(product.id) ?? {
		skus: [],
		categories: [],
		tags: [],
		galleryImages: [],
	};
}

type InFilter = { in: string[] };

async function loadProductsReadMetadata(
	collections: ProductReadCollections,
	context: {
		products: StoredProduct[];
		includeGalleryImages?: boolean;
	},
): Promise<Map<string, ProductReadMetadata>> {
	const productIds = toUniqueStringList(context.products.map((product) => product.id));
	const includeGalleryImages = context.includeGalleryImages ?? false;
	if (productIds.length === 0) {
		return new Map();
	}

	const productsById = new Map<string, StoredProduct>(context.products.map((product) => [product.id, product]));
	const skusResult = await collections.productSkus.query({
		where: { productId: { in: productIds } },
	});
	const skusByProduct = new Map<string, StoredProductSku[]>();
	for (const row of skusResult.items) {
		const current = skusByProduct.get(row.data.productId) ?? [];
		current.push(row.data);
		skusByProduct.set(row.data.productId, current);
	}

	const hydratedSkusByProductEntries = await Promise.all(
		productIds.map(async (productId) => {
			const product = productsById.get(productId);
			const skus = skusByProduct.get(productId) ?? [];
			return [productId, product ? await hydrateSkusWithInventoryStock(product, skus, collections.inventoryStock) : []] as const;
		}),
	);
	const hydratedSkusByProduct = new Map(hydratedSkusByProductEntries);

	const categoriesByProduct = await queryCategoryDtosForProducts(
		collections.productCategoryLinks,
		collections.productCategories,
		productIds,
	);
	const tagsByProduct = await queryTagDtosForProducts(
		collections.productTagLinks,
		collections.productTags,
		productIds,
	);
	const primaryImageByProduct = await queryProductImagesByRoleForTargets(
		collections.productAssetLinks,
		collections.productAssets,
		"product",
		productIds,
		["primary_image"],
	);
	const galleryImageByProduct = includeGalleryImages
		? await queryProductImagesByRoleForTargets(
			collections.productAssetLinks,
			collections.productAssets,
			"product",
			productIds,
			["gallery_image"],
		)
		: new Map();

	const metadataByProduct = new Map<string, ProductReadMetadata>();
	for (const productId of productIds) {
		metadataByProduct.set(productId, {
			skus: hydratedSkusByProduct.get(productId) ?? [],
			categories: categoriesByProduct.get(productId) ?? [],
			tags: tagsByProduct.get(productId) ?? [],
			primaryImage: primaryImageByProduct.get(productId)?.[0],
			galleryImages: galleryImageByProduct.get(productId) ?? [],
		});
	}
	return metadataByProduct;
}

function summarizeSkuPricing(skus: StoredProductSku[]): ProductPriceRangeDTO {
	if (skus.length === 0) return { minUnitPriceMinor: undefined, maxUnitPriceMinor: undefined };
	const prices = skus.filter((sku) => sku.status === "active").map((sku) => sku.unitPriceMinor);
	if (prices.length === 0) {
		return { minUnitPriceMinor: undefined, maxUnitPriceMinor: undefined };
	}
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	return { minUnitPriceMinor: min, maxUnitPriceMinor: max };
}

async function queryProductImagesByRoleForTargets(
	productAssetLinks: Collection<StoredProductAssetLink>,
	productAssets: Collection<StoredProductAsset>,
	targetType: ProductAssetLinkTarget,
	targetIds: string[],
	roles: ProductAssetRole[],
): Promise<Map<string, ProductPrimaryImageDTO[]>> {
	const normalizedTargetIds = toUniqueStringList(targetIds);
	const normalizedRoles = toUniqueStringList(roles);
	if (normalizedTargetIds.length === 0 || normalizedRoles.length === 0) {
		return new Map();
	}

	const targetIdFilter: string | InFilter = normalizedTargetIds.length === 1
		? normalizedTargetIds[0]!
		: { in: normalizedTargetIds };
	const roleFilter: string | InFilter = normalizedRoles.length === 1
		? normalizedRoles[0]!
		: { in: normalizedRoles };

	const query: { where: Record<string, string | number | InFilter> } = {
		where: {
			targetType,
			targetId: targetIdFilter,
			role: roleFilter,
		},
	};
	const links = await productAssetLinks.query(query).then((result) => result.items);
	const assetIds = toUniqueStringList(links.map((link) => link.data.assetId));
	const assetsById = await getManyByIds(productAssets, assetIds);
	const linksByTarget = new Map<string, StoredProductAssetLink[]>();
	for (const link of links) {
		const normalized = linksByTarget.get(link.data.targetId) ?? [];
		normalized.push(link.data);
		linksByTarget.set(link.data.targetId, normalized);
	}

	const imagesByTarget = new Map<string, ProductPrimaryImageDTO[]>();
	for (const [targetId, targetLinks] of linksByTarget) {
		const sortedLinks = sortOrderedRowsByPosition(targetLinks);
		const rows: ProductPrimaryImageDTO[] = [];
		for (const link of sortedLinks) {
			const asset = assetsById.get(link.assetId);
			if (!asset) {
				continue;
			}
			rows.push({
				linkId: link.id,
				assetId: asset.id,
				provider: asset.provider,
				externalAssetId: asset.externalAssetId,
				fileName: asset.fileName,
				altText: asset.altText,
			});
		}
		imagesByTarget.set(targetId, rows);
	}
	return imagesByTarget;
}

async function querySkuOptionValuesBySkuIds(
	productSkuOptionValues: Collection<StoredProductSkuOptionValue>,
	skuIds: string[],
): Promise<Map<string, Array<{ attributeId: string; attributeValueId: string }>>> {
	const normalizedSkuIds = toUniqueStringList(skuIds);
	if (normalizedSkuIds.length === 0) {
		return new Map();
	}

	const result = await productSkuOptionValues.query({
		where: { skuId: { in: normalizedSkuIds } },
	});
	const bySkuId = new Map<string, Array<{ attributeId: string; attributeValueId: string }>>();
	for (const row of result.items) {
		const current = bySkuId.get(row.data.skuId) ?? [];
		current.push({
			attributeId: row.data.attributeId,
			attributeValueId: row.data.attributeValueId,
		});
		bySkuId.set(row.data.skuId, current);
	}
	return bySkuId;
}

type ProductDigitalEntitlementSummaryRow = {
	entitlementId: string;
	digitalAssetId: string;
	digitalAssetLabel?: string;
	downloadLimit?: number;
	downloadExpiryDays?: number;
	grantedQuantity: number;
	isManualOnly: boolean;
	isPrivate: boolean;
};

async function queryDigitalEntitlementSummariesBySkuIds(
	productDigitalEntitlements: Collection<StoredDigitalEntitlement>,
	productDigitalAssets: Collection<StoredDigitalAsset>,
	skuIds: string[],
): Promise<Map<string, ProductDigitalEntitlementSummaryRow[]>> {
	const normalizedSkuIds = toUniqueStringList(skuIds);
	if (normalizedSkuIds.length === 0) {
		return new Map();
	}

	const entitlementRows = await productDigitalEntitlements.query({
		where: { skuId: { in: normalizedSkuIds } },
	});
	const assetIds = toUniqueStringList(
		entitlementRows.items.map((row) => row.data.digitalAssetId),
	);
	const assetsById = await getManyByIds(productDigitalAssets, assetIds);
	const summariesBySku = new Map<string, ProductDigitalEntitlementSummaryRow[]>();
	for (const entitlement of entitlementRows.items) {
		const asset = assetsById.get(entitlement.data.digitalAssetId);
		if (!asset) {
			continue;
		}
		const current = summariesBySku.get(entitlement.data.skuId) ?? [];
		current.push({
			entitlementId: entitlement.data.id,
			digitalAssetId: entitlement.data.digitalAssetId,
			digitalAssetLabel: asset.label,
			grantedQuantity: entitlement.data.grantedQuantity,
			downloadLimit: asset.downloadLimit,
			downloadExpiryDays: asset.downloadExpiryDays,
			isManualOnly: asset.isManualOnly,
			isPrivate: asset.isPrivate,
		});
		summariesBySku.set(entitlement.data.skuId, current);
	}
	return summariesBySku;
}

export async function createProductHandler(ctx: RouteContext<ProductCreateInput>): Promise<ProductResponse> {
	requirePost(ctx);

	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productAttributes = asCollection<StoredProductAttribute>(ctx.storage.productAttributes);
	const productAttributeValues = asCollection<StoredProductAttributeValue>(ctx.storage.productAttributeValues);
	const type = ctx.input.type ?? "simple";
	const status = ctx.input.status ?? "draft";
	const visibility = ctx.input.visibility ?? "hidden";
	const shortDescription = ctx.input.shortDescription ?? "";
	const longDescription = ctx.input.longDescription ?? "";
	const featured = ctx.input.featured ?? false;
	const sortOrder = ctx.input.sortOrder ?? 0;
	const requiresShippingDefault = ctx.input.requiresShippingDefault ?? true;
	const bundleDiscountType = ctx.input.bundleDiscountType ?? "none";
	const inputAttributes = (ctx.input.attributes ?? []).map((attributeInput) => ({
		...attributeInput,
		kind: attributeInput.kind ?? "descriptive",
		position: attributeInput.position ?? 0,
		values: attributeInput.values ?? [],
	}));
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();

	const existing = await products.query({
		where: { slug: ctx.input.slug },
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest(`Product slug already exists: ${ctx.input.slug}`);
	}

	const id = `prod_${await randomHex(6)}`;

	if (type !== "variable" && inputAttributes.length > 0) {
		throw PluginRouteError.badRequest("Only variable products can define attributes");
	}

	if (type === "variable" && inputAttributes.length === 0) {
		throw PluginRouteError.badRequest("Variable products must define at least one attribute");
	}

	const variantAttributeCount = inputAttributes.filter((attribute) => attribute.kind === "variant_defining").length;
	if (type === "variable" && variantAttributeCount === 0) {
		throw PluginRouteError.badRequest("Variable products must include at least one variant-defining attribute");
	}

	const attributeCodes = new Set<string>();
	for (const attribute of inputAttributes) {
		if (attributeCodes.has(attribute.code)) {
			throw PluginRouteError.badRequest(`Duplicate attribute code: ${attribute.code}`);
		}
		attributeCodes.add(attribute.code);

		const valueCodes = new Set<string>();
		for (const value of attribute.values) {
			if (valueCodes.has(value.code)) {
				throw PluginRouteError.badRequest(`Duplicate value code ${value.code} for attribute ${attribute.code}`);
			}
			valueCodes.add(value.code);
		}
	}

	const product: StoredProduct = {
		id,
		type,
		status,
		visibility,
		slug: ctx.input.slug,
		title: ctx.input.title,
		shortDescription,
		longDescription,
		brand: ctx.input.brand,
		vendor: ctx.input.vendor,
		featured,
		sortOrder,
		requiresShippingDefault,
		taxClassDefault: ctx.input.taxClassDefault,
		bundleDiscountType,
		bundleDiscountValueMinor: ctx.input.bundleDiscountValueMinor,
		bundleDiscountValueBps: ctx.input.bundleDiscountValueBps,
		metadataJson: {},
		createdAt: nowIso,
		updatedAt: nowIso,
		publishedAt: status === "active" ? nowIso : undefined,
		archivedAt: status === "archived" ? nowIso : undefined,
	};

	await products.put(id, product);

	for (const attributeInput of inputAttributes) {
		const attributeId = `${id}_attr_${await randomHex(6)}`;
		const nowAttribute: StoredProductAttribute = {
			id: attributeId,
			productId: id,
			name: attributeInput.name,
			code: attributeInput.code,
			kind: attributeInput.kind,
			position: attributeInput.position,
			createdAt: nowIso,
			updatedAt: nowIso,
		};
		await productAttributes.put(attributeId, nowAttribute);

		for (const valueInput of attributeInput.values) {
			const valueId = `${attributeId}_val_${await randomHex(6)}`;
			await productAttributeValues.put(valueId, {
				id: valueId,
				attributeId,
				value: valueInput.value,
				code: valueInput.code,
				position: valueInput.position ?? 0,
				createdAt: nowIso,
				updatedAt: nowIso,
			});
		}
	}

	return { product };
}

export async function updateProductHandler(ctx: RouteContext<ProductUpdateInput>): Promise<ProductResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const nowIso = new Date(Date.now()).toISOString();

	const existing = await products.get(ctx.input.productId);
	if (!existing) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const { productId, ...patch } = ctx.input;
	if (patch.slug !== undefined && patch.slug !== existing.slug) {
		const slugRows = await products.query({
			where: { slug: patch.slug },
			limit: 1,
		});
		if (slugRows.items.some((row) => row.id !== productId)) {
			throw PluginRouteError.badRequest(`Product slug already exists: ${patch.slug}`);
		}
	}
	assertBundleDiscountPatchForProduct(existing, patch);

	const product = applyProductUpdatePatch(existing, patch, nowIso);

	await products.put(productId, product);
	return { product };
}

export async function setProductStateHandler(ctx: RouteContext<ProductStateInput>): Promise<ProductResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const nowIso = new Date(Date.now()).toISOString();

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}

	const updated: StoredProduct = {
		...product,
		status: ctx.input.status,
		updatedAt: nowIso,
		publishedAt: ctx.input.status === "active" ? nowIso : product.publishedAt,
		archivedAt: ctx.input.status === "archived" ? nowIso : product.archivedAt,
	};
	if (ctx.input.status === "draft") {
		updated.archivedAt = undefined;
	}

	await products.put(ctx.input.productId, updated);
	return { product: updated };
}

export async function getProductHandler(ctx: RouteContext<ProductGetInput>): Promise<ProductResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const productAttributes = asCollection<StoredProductAttribute>(ctx.storage.productAttributes);
	const productSkuOptionValues = asCollection<StoredProductSkuOptionValue>(ctx.storage.productSkuOptionValues);
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const productCategories = asCollection<StoredCategory>(ctx.storage.categories);
	const productCategoryLinks = asCollection<StoredProductCategoryLink>(ctx.storage.productCategoryLinks);
	const productTags = asCollection<StoredProductTag>(ctx.storage.productTags);
	const productTagLinks = asCollection<StoredProductTagLink>(ctx.storage.productTagLinks);
	const productDigitalAssets = asCollection<StoredDigitalAsset>(ctx.storage.digitalAssets);
	const productDigitalEntitlements = asCollection<StoredDigitalEntitlement>(ctx.storage.digitalEntitlements);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const { skus: skuRows, categories, tags, primaryImage, galleryImages } =
		await loadProductReadMetadata({
			productCategoryLinks,
			productCategories,
			productTagLinks,
			productTags,
			productAssets,
			productAssetLinks,
			productSkus,
			inventoryStock,
		}, {
			product,
			includeGalleryImages: true,
		});
	const response: ProductResponse = { product, skus: skuRows, categories, tags };
	if (primaryImage) response.primaryImage = primaryImage;
	if (galleryImages.length > 0) response.galleryImages = galleryImages;

	if (product.type === "variable") {
		const attributes = (await productAttributes.query({ where: { productId: product.id } })).items.map(
			(row) => row.data,
		);
		const skuOptionValuesBySku = await querySkuOptionValuesBySkuIds(
			productSkuOptionValues,
			skuRows.map((sku) => sku.id),
		);
		const variantImageBySku = await queryProductImagesByRoleForTargets(
			productAssetLinks,
			productAssets,
			"sku",
			skuRows.map((sku) => sku.id),
			["variant_image"],
		);
		const variantMatrix: VariantMatrixDTO[] = [];
		for (const skuRow of skuRows) {
			const variantImage = variantImageBySku.get(skuRow.id)?.[0];
			const options = skuOptionValuesBySku.get(skuRow.id) ?? [];
			variantMatrix.push({
				skuId: skuRow.id,
				skuCode: skuRow.skuCode,
				status: skuRow.status,
				unitPriceMinor: skuRow.unitPriceMinor,
				compareAtPriceMinor: skuRow.compareAtPriceMinor,
				inventoryQuantity: skuRow.inventoryQuantity,
				inventoryVersion: skuRow.inventoryVersion,
				requiresShipping: skuRow.requiresShipping,
				isDigital: skuRow.isDigital,
				image: variantImage,
				options,
			});
		}
		response.attributes = attributes;
		response.variantMatrix = variantMatrix;
	}

	if (product.type === "bundle") {
		const components = await queryBundleComponentsForProduct(bundleComponents, product.id);
		const componentSkus = await getManyByIds(productSkus, components.map((component) => component.componentSkuId));
		const componentProductIds = toUniqueStringList(
			components.map((component) => componentSkus.get(component.componentSkuId)?.productId).filter((value): value is string => Boolean(value)),
		);
		const componentProducts = await getManyByIds(products, componentProductIds);

		const componentLines = await Promise.all(
			components.map(async (component) => {
				const componentSku = componentSkus.get(component.componentSkuId);
				if (!componentSku) {
					throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "Bundle component SKU not found" });
				}
				const componentProduct = componentProducts.get(componentSku.productId);
				if (!componentProduct) {
					throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle component product not found" });
				}
				const hydratedComponentSkus = await hydrateSkusWithInventoryStock(
					componentProduct,
					[componentSku],
					inventoryStock,
				);
				return { component, sku: hydratedComponentSkus[0] ?? componentSku };
			}),
		);
		response.bundleSummary = computeBundleSummary(
			product.id,
			product.bundleDiscountType,
			product.bundleDiscountValueMinor,
			product.bundleDiscountValueBps,
			componentLines,
		);
	}

	const digitalEntitlements: ProductDigitalEntitlementSummary[] = [];
	const entitlementsBySku = await queryDigitalEntitlementSummariesBySkuIds(
		productDigitalEntitlements,
		productDigitalAssets,
		skuRows.map((sku) => sku.id),
	);
	for (const sku of skuRows) {
		const entitlements = entitlementsBySku.get(sku.id);
		if (!entitlements || entitlements.length === 0) {
			continue;
		}
		digitalEntitlements.push({
			skuId: sku.id,
			entitlements,
		});
	}
	if (digitalEntitlements.length > 0) {
		response.digitalEntitlements = digitalEntitlements;
	}
	return response;
}

export async function listProductsHandler(ctx: RouteContext<ProductListInput>): Promise<ProductListResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const productCategories = asCollection<StoredCategory>(ctx.storage.categories);
	const productCategoryLinks = asCollection<StoredProductCategoryLink>(ctx.storage.productCategoryLinks);
	const productTags = asCollection<StoredProductTag>(ctx.storage.productTags);
	const productTagLinks = asCollection<StoredProductTagLink>(ctx.storage.productTagLinks);
	const where = toWhere(ctx.input);
	const includeCategoryId = ctx.input.categoryId;
	const includeTagId = ctx.input.tagId;

	const result = await products.query({
		where,
	});
	let rows = result.items.map((row) => row.data);

	if (includeCategoryId) {
		const categoryLinks = await productCategoryLinks.query({ where: { categoryId: includeCategoryId } });
		const allowedProductIds = new Set(categoryLinks.items.map((item) => item.data.productId));
		rows = rows.filter((row) => allowedProductIds.has(row.id));
	}

	if (includeTagId) {
		const tagLinks = await productTagLinks.query({ where: { tagId: includeTagId } });
		const allowedProductIds = new Set(tagLinks.items.map((item) => item.data.productId));
		rows = rows.filter((row) => allowedProductIds.has(row.id));
	}

	const sortedRows = sortedImmutable(rows, (left, right) => left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug)).slice(
		0,
		ctx.input.limit,
	);
	const metadataByProduct = await loadProductsReadMetadata(
		{
			productCategoryLinks,
			productCategories,
			productTagLinks,
			productTags,
			productAssets,
			productAssetLinks,
			productSkus,
			inventoryStock,
		},
		{
			products: sortedRows,
			includeGalleryImages: true,
		},
	);
	const items: CatalogListingDTO[] = [];
	for (const row of sortedRows) {
		const { skus: skuRows, categories, tags, primaryImage, galleryImages } = metadataByProduct.get(row.id) ?? {
			skus: [],
			categories: [],
			tags: [],
			galleryImages: [],
		};

		items.push({
			product: row,
			priceRange: summarizeSkuPricing(skuRows),
			inventorySummary: summarizeInventory(skuRows),
			primaryImage,
			galleryImages: galleryImages.length > 0 ? galleryImages : undefined,
			lowStockSkuCount: skuRows.filter(
				(sku) => sku.status === "active" && sku.inventoryQuantity <= COMMERCE_LIMITS.lowStockThreshold,
			).length,
			categories,
			tags,
		});
	}

	return { items };
}

export async function createCategoryHandler(ctx: RouteContext<CategoryCreateInput>): Promise<CategoryResponse> {
	requirePost(ctx);
	const categories = asCollection<StoredCategory>(ctx.storage.categories);
	const nowIso = new Date(Date.now()).toISOString();
	const existing = await categories.query({
		where: { slug: ctx.input.slug },
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest(`Category slug already exists: ${ctx.input.slug}`);
	}

	if (ctx.input.parentId) {
		const parent = await categories.get(ctx.input.parentId);
		if (!parent) {
			throw PluginRouteError.badRequest(`Category parent not found: ${ctx.input.parentId}`);
		}
	}

	const id = `cat_${await randomHex(6)}`;
	const category: StoredCategory = {
		id,
		name: ctx.input.name,
		slug: ctx.input.slug,
		parentId: ctx.input.parentId,
		position: ctx.input.position,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await categories.put(id, category);
	return { category };
}

export async function listCategoriesHandler(ctx: RouteContext<CategoryListInput>): Promise<CategoryListResponse> {
	requirePost(ctx);
	const categories = asCollection<StoredCategory>(ctx.storage.categories);

	const where: Record<string, string> = {};
	if (ctx.input.parentId) {
		where.parentId = ctx.input.parentId;
	}

	const result = await categories.query({
		where,
		limit: ctx.input.limit,
	});
	const items = sortedImmutable(
		result.items.map((row) => row.data),
		(left, right) => left.position - right.position || left.slug.localeCompare(right.slug),
	);
	return { items };
}

export async function createProductCategoryLinkHandler(
	ctx: RouteContext<ProductCategoryLinkInput>,
): Promise<ProductCategoryLinkResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const categories = asCollection<StoredCategory>(ctx.storage.categories);
	const productCategoryLinks = asCollection<StoredProductCategoryLink>(ctx.storage.productCategoryLinks);
	const nowIso = new Date(Date.now()).toISOString();

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const category = await categories.get(ctx.input.categoryId);
	if (!category) {
		throw PluginRouteError.badRequest(`Category not found: ${ctx.input.categoryId}`);
	}

	const existing = await productCategoryLinks.query({
		where: {
			productId: ctx.input.productId,
			categoryId: ctx.input.categoryId,
		},
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest("Product-category link already exists");
	}

	const id = `prod_cat_link_${await randomHex(6)}`;
	const link: StoredProductCategoryLink = {
		id,
		productId: ctx.input.productId,
		categoryId: ctx.input.categoryId,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await productCategoryLinks.put(id, link);
	return { link };
}

export async function removeProductCategoryLinkHandler(
	ctx: RouteContext<ProductCategoryUnlinkInput>,
): Promise<ProductCategoryLinkUnlinkResponse> {
	requirePost(ctx);
	const productCategoryLinks = asCollection<StoredProductCategoryLink>(ctx.storage.productCategoryLinks);
	const link = await productCategoryLinks.get(ctx.input.linkId);
	if (!link) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product-category link not found" });
	}

	await productCategoryLinks.delete(ctx.input.linkId);
	return { deleted: true };
}

export async function createTagHandler(ctx: RouteContext<TagCreateInput>): Promise<TagResponse> {
	requirePost(ctx);
	const tags = asCollection<StoredProductTag>(ctx.storage.productTags);
	const nowIso = new Date(Date.now()).toISOString();
	const existing = await tags.query({
		where: { slug: ctx.input.slug },
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest(`Tag slug already exists: ${ctx.input.slug}`);
	}

	const id = `tag_${await randomHex(6)}`;
	const tag: StoredProductTag = {
		id,
		name: ctx.input.name,
		slug: ctx.input.slug,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await tags.put(id, tag);
	return { tag };
}

export async function listTagsHandler(ctx: RouteContext<TagListInput>): Promise<TagListResponse> {
	requirePost(ctx);
	const tags = asCollection<StoredProductTag>(ctx.storage.productTags);
	const result = await tags.query({
		limit: ctx.input.limit,
	});
	const items = sortedImmutable(result.items.map((row) => row.data), (left, right) => left.slug.localeCompare(right.slug));
	return { items };
}

export async function createProductTagLinkHandler(
	ctx: RouteContext<ProductTagLinkInput>,
): Promise<ProductTagLinkResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const tags = asCollection<StoredProductTag>(ctx.storage.productTags);
	const productTagLinks = asCollection<StoredProductTagLink>(ctx.storage.productTagLinks);
	const nowIso = new Date(Date.now()).toISOString();

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const tag = await tags.get(ctx.input.tagId);
	if (!tag) {
		throw PluginRouteError.badRequest(`Tag not found: ${ctx.input.tagId}`);
	}

	const existing = await productTagLinks.query({
		where: {
			productId: ctx.input.productId,
			tagId: ctx.input.tagId,
		},
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest("Product-tag link already exists");
	}

	const id = `prod_tag_link_${await randomHex(6)}`;
	const link: StoredProductTagLink = {
		id,
		productId: ctx.input.productId,
		tagId: ctx.input.tagId,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await productTagLinks.put(id, link);
	return { link };
}

export async function removeProductTagLinkHandler(ctx: RouteContext<ProductTagUnlinkInput>): Promise<ProductTagLinkUnlinkResponse> {
	requirePost(ctx);
	const productTagLinks = asCollection<StoredProductTagLink>(ctx.storage.productTagLinks);
	const link = await productTagLinks.get(ctx.input.linkId);
	if (!link) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product-tag link not found" });
	}
	await productTagLinks.delete(ctx.input.linkId);
	return { deleted: true };
}

export async function createProductSkuHandler(
	ctx: RouteContext<ProductSkuCreateInput>,
): Promise<ProductSkuResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const productAttributes = asCollection<StoredProductAttribute>(ctx.storage.productAttributes);
	const productAttributeValues = asCollection<StoredProductAttributeValue>(
		ctx.storage.productAttributeValues,
	);
	const productSkuOptionValues = asCollection<StoredProductSkuOptionValue>(ctx.storage.productSkuOptionValues);
	const inputOptionValues = ctx.input.optionValues ?? [];

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	if (product.status === "archived") {
		throw PluginRouteError.badRequest("Cannot add SKUs to an archived product");
	}

	const existingSku = await productSkus.query({
		where: { skuCode: ctx.input.skuCode },
		limit: 1,
	});
	if (existingSku.items.length > 0) {
		throw PluginRouteError.badRequest(`SKU code already exists: ${ctx.input.skuCode}`);
	}
	const existingSkuCount = (await productSkus.query({ where: { productId: product.id } })).items.length;
	assertSimpleProductSkuCapacity(product, existingSkuCount);

	if (product.type !== "variable" && inputOptionValues.length > 0) {
		throw PluginRouteError.badRequest("Option values are only allowed for variable products");
	}

	if (product.type === "variable") {
		const attributesResult = await productAttributes.query({ where: { productId: product.id } });
		const variantAttributes = collectVariantDefiningAttributes(
			attributesResult.items.map((row) => row.data),
		);
		if (variantAttributes.length === 0) {
			throw PluginRouteError.badRequest(`Product ${product.id} has no variant-defining attributes`);
		}

		let attributeValueRows: StoredProductAttributeValue[] = [];
		for (const attribute of variantAttributes) {
			const valueResult = await productAttributeValues.query({ where: { attributeId: attribute.id } });
			attributeValueRows = [...attributeValueRows, ...valueResult.items.map((row) => row.data)];
		}

		const existingSkuResult = await productSkus.query({ where: { productId: product.id } });
		const existingSignatures = new Set<string>();
		for (const row of existingSkuResult.items) {
			const optionResult = await productSkuOptionValues.query({ where: { skuId: row.data.id } });
			const options = optionResult.items.map((option) => ({
				attributeId: option.data.attributeId,
				attributeValueId: option.data.attributeValueId,
			}));
			const signature = normalizeSkuOptionSignature(options);
			if (options.length > 0) {
				existingSignatures.add(signature);
			}
		}

		validateVariableSkuOptions({
			productId: product.id,
			variantAttributes,
			attributeValues: attributeValueRows,
			optionValues: inputOptionValues,
			existingSignatures,
		});
	}

	const nowIso = new Date(Date.now()).toISOString();
	const id = `sku_${ctx.input.productId}_${await randomHex(6)}`;
	const status = ctx.input.status ?? "active";
	const requiresShipping = ctx.input.requiresShipping ?? true;
	const isDigital = ctx.input.isDigital ?? false;
	const inventoryVersion = ctx.input.inventoryVersion ?? 1;
	const sku: StoredProductSku = {
		id,
		productId: ctx.input.productId,
		skuCode: ctx.input.skuCode,
		status,
		unitPriceMinor: ctx.input.unitPriceMinor,
		compareAtPriceMinor: ctx.input.compareAtPriceMinor,
		inventoryQuantity: ctx.input.inventoryQuantity,
		inventoryVersion,
		requiresShipping,
		isDigital,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	await productSkus.put(id, sku);
	await syncInventoryStockForSku(
		inventoryStock,
		product,
		sku,
		nowIso,
		product.type !== "variable" && existingSkuCount === 0,
	);

	if (product.type === "variable") {
		for (const optionInput of inputOptionValues) {
			const optionId = `${id}_opt_${await randomHex(6)}`;
			const optionRow: StoredProductSkuOptionValue = {
				id: optionId,
				skuId: id,
				attributeId: optionInput.attributeId,
				attributeValueId: optionInput.attributeValueId,
				createdAt: nowIso,
				updatedAt: nowIso,
			};
			await productSkuOptionValues.put(optionId, optionRow);
		}
	}
	return { sku };
}

export async function updateProductSkuHandler(
	ctx: RouteContext<ProductSkuUpdateInput>,
): Promise<ProductSkuResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const nowIso = new Date(Date.now()).toISOString();

	const existing = await productSkus.get(ctx.input.skuId);
	if (!existing) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}

	const { skuId, ...patch } = ctx.input;
	if (patch.skuCode !== undefined && patch.skuCode !== existing.skuCode) {
		const existingSkuRows = await productSkus.query({
			where: { skuCode: patch.skuCode },
			limit: 1,
		});
		if (existingSkuRows.items.some((row) => row.id !== skuId)) {
			throw PluginRouteError.badRequest(`SKU code already exists: ${patch.skuCode}`);
		}
	}
	const sku = applyProductSkuUpdatePatch(existing, patch, nowIso);
	await productSkus.put(skuId, sku);
	const shouldSyncInventoryStock =
		patch.inventoryQuantity !== undefined || patch.inventoryVersion !== undefined;
	if (shouldSyncInventoryStock) {
		const product = await products.get(existing.productId);
		if (!product) {
			throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
		}
		const productSkusForProduct = await productSkus.query({ where: { productId: product.id } });
		const includeProductLevelStock = product.type !== "variable" && productSkusForProduct.items.length === 1;
		await syncInventoryStockForSku(
			inventoryStock,
			product,
			sku,
			nowIso,
			includeProductLevelStock,
		);
	}

	return { sku };
}

export async function setSkuStatusHandler(ctx: RouteContext<ProductSkuStateInput>): Promise<ProductSkuResponse> {
	requirePost(ctx);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);

	const existing = await productSkus.get(ctx.input.skuId);
	if (!existing) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}

	const updated: StoredProductSku = {
		...existing,
		status: ctx.input.status,
		updatedAt: new Date(Date.now()).toISOString(),
	};
	await productSkus.put(ctx.input.skuId, updated);
	return { sku: updated };
}

export async function listProductSkusHandler(
	ctx: RouteContext<ProductSkuListInput>,
): Promise<ProductSkuListResponse> {
	requirePost(ctx);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);

	const result = await productSkus.query({
		where: { productId: ctx.input.productId },
		limit: ctx.input.limit,
	});
	const items = result.items.map((row) => row.data);

	return { items };
}

async function queryAssetLinksForTarget(
	productAssetLinks: Collection<StoredProductAssetLink>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
): Promise<StoredProductAssetLink[]> {
	const result = await productAssetLinks.query({ where: { targetType, targetId } });
	return normalizeOrderedChildren(sortOrderedRowsByPosition(result.items.map((row) => row.data)));
}

async function loadCatalogTargetExists(
	products: Collection<StoredProduct>,
	productSkus: Collection<StoredProductSku>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
) {
	if (targetType === "product") {
		const product = await products.get(targetId);
		if (!product) {
			throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
		}
		return;
	}

	const sku = await productSkus.get(targetId);
	if (!sku) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}
}

export async function registerProductAssetHandler(
	ctx: RouteContext<ProductAssetRegisterInput>,
): Promise<ProductAssetResponse> {
	requirePost(ctx);
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const nowIso = new Date(Date.now()).toISOString();

	const existing = await productAssets.query({
		where: {
			provider: ctx.input.provider,
			externalAssetId: ctx.input.externalAssetId,
		},
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest("Asset metadata already registered for provider asset key");
	}

	const id = `asset_${await randomHex(6)}`;
	const asset: StoredProductAsset = {
		id,
		provider: ctx.input.provider,
		externalAssetId: ctx.input.externalAssetId,
		fileName: ctx.input.fileName,
		altText: ctx.input.altText,
		mimeType: ctx.input.mimeType,
		byteSize: ctx.input.byteSize,
		width: ctx.input.width,
		height: ctx.input.height,
		metadata: ctx.input.metadata,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	await productAssets.put(id, asset);
	return { asset };
}

export async function linkCatalogAssetHandler(ctx: RouteContext<ProductAssetLinkInput>): Promise<ProductAssetLinkResponse> {
	requirePost(ctx);
	const role = ctx.input.role ?? "gallery_image";
	const position = ctx.input.position ?? 0;
	const nowIso = new Date(Date.now()).toISOString();
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const skus = asCollection<StoredProductSku>(ctx.storage.productSkus);

	const targetType = ctx.input.targetType;
	const targetId = ctx.input.targetId;

	const asset = await productAssets.get(ctx.input.assetId);
	if (!asset) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Asset not found" });
	}

	await loadCatalogTargetExists(products, skus, targetType, targetId);

	const links = await queryAssetLinksForTarget(productAssetLinks, targetType, targetId);
	if (role === "primary_image") {
		const hasPrimary = links.some((link) => link.role === "primary_image");
		if (hasPrimary) {
			throw PluginRouteError.badRequest("Target already has a primary image");
		}
	}

	const duplicate = links.some((link) => link.assetId === ctx.input.assetId);
	if (duplicate) {
		throw PluginRouteError.badRequest("Asset already linked to this target");
	}

	const linkId = `asset_link_${await randomHex(6)}`;
	const requestedPosition = normalizeOrderedPosition(position);

	const link: StoredProductAssetLink = {
		id: linkId,
		targetType,
		targetId,
		assetId: ctx.input.assetId,
		role,
		position: requestedPosition,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const normalized = await mutateOrderedChildren({
		collection: productAssetLinks,
		rows: links,
		mutation: {
			kind: "add",
			row: link,
			requestedPosition,
		},
		nowIso,
	});

	const created = normalized.find((candidate) => candidate.id === linkId);
	if (!created) {
		throw PluginRouteError.badRequest("Asset link not found after create");
	}
	return { link: created };
}

export async function unlinkCatalogAssetHandler(
	ctx: RouteContext<ProductAssetUnlinkInput>,
): Promise<ProductAssetUnlinkResponse> {
	requirePost(ctx);
	const nowIso = new Date(Date.now()).toISOString();
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const existing = await productAssetLinks.get(ctx.input.linkId);
	if (!existing) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Asset link not found" });
	}
	const links = await queryAssetLinksForTarget(productAssetLinks, existing.targetType, existing.targetId);

	await productAssetLinks.delete(ctx.input.linkId);
	await mutateOrderedChildren({
		collection: productAssetLinks,
		rows: links,
		mutation: {
			kind: "remove",
			removedRowId: ctx.input.linkId,
		},
		nowIso,
	});

	return { deleted: true };
}

export async function reorderCatalogAssetHandler(
	ctx: RouteContext<ProductAssetReorderInput>,
): Promise<ProductAssetLinkResponse> {
	requirePost(ctx);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const nowIso = new Date(Date.now()).toISOString();

	const link = await productAssetLinks.get(ctx.input.linkId);
	if (!link) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Asset link not found" });
	}

	const links = await queryAssetLinksForTarget(productAssetLinks, link.targetType, link.targetId);
	const requestedPosition = normalizeOrderedPosition(ctx.input.position);
	const normalized = await mutateOrderedChildren({
		collection: productAssetLinks,
		rows: links,
		mutation: {
			kind: "move",
			rowId: ctx.input.linkId,
			requestedPosition,
			notFoundMessage: "Asset link not found in target links",
		},
		nowIso,
	});

	const updated = normalized.find((candidate) => candidate.id === ctx.input.linkId);
	if (!updated) {
		throw PluginRouteError.badRequest("Asset link not found after reorder");
	}
	return { link: updated };
}

export async function addBundleComponentHandler(
	ctx: RouteContext<BundleComponentAddInput>,
): Promise<BundleComponentResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);
	const nowIso = new Date(Date.now()).toISOString();

	const bundleProduct = await products.get(ctx.input.bundleProductId);
	if (!bundleProduct) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle product not found" });
	}
	if (bundleProduct.type !== "bundle") {
		throw PluginRouteError.badRequest("Target product is not a bundle");
	}

	const componentSku = await productSkus.get(ctx.input.componentSkuId);
	if (!componentSku) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "Component SKU not found" });
	}
	if (componentSku.productId === bundleProduct.id) {
		throw PluginRouteError.badRequest("Bundle cannot include component from itself");
	}
	const componentProduct = await products.get(componentSku.productId);
	if (!componentProduct) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Component product not found" });
	}
	if (componentProduct.type === "bundle") {
		throw PluginRouteError.badRequest("Bundle cannot include component products that are themselves bundles");
	}

	const existingComponent = await bundleComponents.query({
		where: { bundleProductId: bundleProduct.id, componentSkuId: ctx.input.componentSkuId },
		limit: 1,
	});
	if (existingComponent.items.length > 0) {
		throw PluginRouteError.badRequest("Bundle already contains this component SKU");
	}

	const existingComponents = await queryBundleComponentsForProduct(bundleComponents, bundleProduct.id);
	const requestedPosition = normalizeOrderedPosition(ctx.input.position);
	const componentId = `bundle_comp_${await randomHex(6)}`;
	const component: StoredBundleComponent = {
		id: componentId,
		bundleProductId: bundleProduct.id,
		componentSkuId: componentSku.id,
		quantity: ctx.input.quantity,
		position: requestedPosition,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const normalized = await mutateOrderedChildren({
		collection: bundleComponents,
		rows: existingComponents,
		mutation: {
			kind: "add",
			row: component,
			requestedPosition,
		},
		nowIso,
	});

	const added = normalized.find((candidate) => candidate.id === componentId);
	if (!added) {
		throw PluginRouteError.badRequest("Bundle component not found after add");
	}
	return { component: added };
}

export async function removeBundleComponentHandler(
	ctx: RouteContext<BundleComponentRemoveInput>,
): Promise<BundleComponentUnlinkResponse> {
	requirePost(ctx);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);
	const nowIso = new Date(Date.now()).toISOString();

	const existing = await bundleComponents.get(ctx.input.bundleComponentId);
	if (!existing) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle component not found" });
	}
	const components = await queryBundleComponentsForProduct(bundleComponents, existing.bundleProductId);

	await bundleComponents.delete(ctx.input.bundleComponentId);
	await mutateOrderedChildren({
		collection: bundleComponents,
		rows: components,
		mutation: {
			kind: "remove",
			removedRowId: ctx.input.bundleComponentId,
		},
		nowIso,
	});
	return { deleted: true };
}

export async function reorderBundleComponentHandler(
	ctx: RouteContext<BundleComponentReorderInput>,
): Promise<BundleComponentResponse> {
	requirePost(ctx);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);
	const nowIso = new Date(Date.now()).toISOString();

	const component = await bundleComponents.get(ctx.input.bundleComponentId);
	if (!component) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle component not found" });
	}

	const components = await queryBundleComponentsForProduct(bundleComponents, component.bundleProductId);
	const requestedPosition = normalizeOrderedPosition(ctx.input.position);
	const normalized = await mutateOrderedChildren({
		collection: bundleComponents,
		rows: components,
		mutation: {
			kind: "move",
			rowId: ctx.input.bundleComponentId,
			requestedPosition,
			notFoundMessage: "Bundle component not found in target bundle",
		},
		nowIso,
	});

	const updated = normalized.find((row) => row.id === ctx.input.bundleComponentId);
	if (!updated) {
		throw PluginRouteError.badRequest("Bundle component not found after reorder");
	}
	return { component: updated };
}

export async function bundleComputeHandler(
	ctx: RouteContext<BundleComputeInput>,
): Promise<BundleComputeResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	if (product.type !== "bundle") {
		throw PluginRouteError.badRequest("Product is not a bundle");
	}

	const components = await queryBundleComponentsForProduct(bundleComponents, product.id);
	const lines: Array<{ component: StoredBundleComponent; sku: StoredProductSku }> = [];
	for (const component of components) {
		const sku = await productSkus.get(component.componentSkuId);
		if (!sku) {
			throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "Bundle component SKU not found" });
		}
		const componentProduct = await products.get(sku.productId);
		if (!componentProduct) {
			throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle component product not found" });
		}
		const hydratedSkus = await hydrateSkusWithInventoryStock(componentProduct, [sku], inventoryStock);
		lines.push({ component, sku: hydratedSkus[0] ?? sku });
	}

	return computeBundleSummary(
		product.id,
		product.bundleDiscountType,
		product.bundleDiscountValueMinor,
		product.bundleDiscountValueBps,
		lines,
	);
}

export async function createDigitalAssetHandler(
	ctx: RouteContext<DigitalAssetCreateInput>,
): Promise<DigitalAssetResponse> {
	requirePost(ctx);
	const provider = ctx.input.provider ?? "media";
	const isManualOnly = ctx.input.isManualOnly ?? false;
	const isPrivate = ctx.input.isPrivate ?? true;
	const productDigitalAssets = asCollection<StoredDigitalAsset>(ctx.storage.digitalAssets);
	const nowIso = new Date(Date.now()).toISOString();

	const existing = await productDigitalAssets.query({
		where: { provider, externalAssetId: ctx.input.externalAssetId },
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest("Digital asset already registered for provider key");
	}

	const id = `digital_asset_${await randomHex(6)}`;
	const asset: StoredDigitalAsset = {
		id,
		provider,
		externalAssetId: ctx.input.externalAssetId,
		label: ctx.input.label,
		downloadLimit: ctx.input.downloadLimit,
		downloadExpiryDays: ctx.input.downloadExpiryDays,
		isManualOnly,
		isPrivate,
		metadata: ctx.input.metadata,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	await productDigitalAssets.put(id, asset);
	return { asset };
}

export async function createDigitalEntitlementHandler(
	ctx: RouteContext<DigitalEntitlementCreateInput>,
): Promise<DigitalEntitlementResponse> {
	requirePost(ctx);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const productDigitalAssets = asCollection<StoredDigitalAsset>(ctx.storage.digitalAssets);
	const productDigitalEntitlements = asCollection<StoredDigitalEntitlement>(
		ctx.storage.digitalEntitlements,
	);
	const nowIso = new Date(Date.now()).toISOString();

	const sku = await productSkus.get(ctx.input.skuId);
	if (!sku) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}
	if (sku.status !== "active") {
		throw PluginRouteError.badRequest(`Cannot attach entitlement to inactive SKU ${ctx.input.skuId}`);
	}

	const digitalAsset = await productDigitalAssets.get(ctx.input.digitalAssetId);
	if (!digitalAsset) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Digital asset not found" });
	}

	const existing = await productDigitalEntitlements.query({
		where: { skuId: ctx.input.skuId, digitalAssetId: ctx.input.digitalAssetId },
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.badRequest("SKU already has this digital entitlement");
	}

	const id = `entitlement_${await randomHex(6)}`;
	const entitlement: StoredDigitalEntitlement = {
		id,
		skuId: ctx.input.skuId,
		digitalAssetId: ctx.input.digitalAssetId,
		grantedQuantity: ctx.input.grantedQuantity,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await productDigitalEntitlements.put(id, entitlement);
	return { entitlement };
}

export async function removeDigitalEntitlementHandler(
	ctx: RouteContext<DigitalEntitlementRemoveInput>,
): Promise<DigitalEntitlementUnlinkResponse> {
	requirePost(ctx);
	const productDigitalEntitlements = asCollection<StoredDigitalEntitlement>(
		ctx.storage.digitalEntitlements,
	);

	const existing = await productDigitalEntitlements.get(ctx.input.entitlementId);
	if (!existing) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Digital entitlement not found" });
	}
	await productDigitalEntitlements.delete(ctx.input.entitlementId);
	return { deleted: true };
}
