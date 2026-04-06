import type { ProductCategoryDTO, ProductPrimaryImageDTO, ProductTagDTO } from "../lib/catalog-dto.js";
import type {
	ProductAssetRole,
	ProductAssetLinkTarget,
	StoredCategory,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredInventoryStock,
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductCategoryLink,
	StoredProductSku,
	StoredProductSkuOptionValue,
	StoredProductTag,
	StoredProductTagLink,
} from "../types.js";
import { sortOrderedRowsByPosition } from "../lib/ordered-rows.js";
import { inventoryStockDocId } from "../lib/inventory-stock.js";

export type StorageQueryResult<T> = {
	items: Array<{ id: string; data: T }>;
	hasMore: boolean;
	cursor?: string;
};

type InFilter = { in: string[] };

export async function queryAllPages<T>(
	queryPage: (cursor?: string) => Promise<StorageQueryResult<T>>,
): Promise<Array<{ id: string; data: T }>> {
	const all: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	while (true) {
		const page = await queryPage(cursor);
		all.push(...page.items);
		if (!page.hasMore || !page.cursor) {
			break;
		}
		cursor = page.cursor;
	}
	return all;
}

export function toUniqueStringList(values: string[]): string[] {
	return [...new Set(values)];
}

export async function getManyByIds<T>(collection: Collection<T>, ids: string[]): Promise<Map<string, T>> {
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

type ProductReadMetadata = {
	skus: StoredProductSku[];
	categories: ProductCategoryDTO[];
	tags: ProductTagDTO[];
	primaryImage?: ProductPrimaryImageDTO;
	galleryImages: ProductPrimaryImageDTO[];
};

type ProductReadContext = {
	product: StoredProduct;
	includeGalleryImages?: boolean;
};

export type ProductReadCollections = {
	productCategoryLinks: Collection<StoredProductCategoryLink>;
	productCategories: Collection<StoredCategory>;
	productTagLinks: Collection<StoredProductTagLink>;
	productTags: Collection<StoredProductTag>;
	productAssets: Collection<StoredProductAsset>;
	productAssetLinks: Collection<StoredProductAssetLink>;
	productSkus: Collection<StoredProductSku>;
	inventoryStock: Collection<StoredInventoryStock> | null;
};

export async function loadProductReadMetadata(
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

export async function loadProductsReadMetadata(
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
	const skusResult = await queryAllPages((cursor) =>
		collections.productSkus.query({
			where: { productId: { in: productIds } },
			cursor,
			limit: 100,
		}),
	);
	const skusByProduct = new Map<string, StoredProductSku[]>();
	for (const row of skusResult) {
		const current = skusByProduct.get(row.data.productId) ?? [];
		current.push(row.data);
		skusByProduct.set(row.data.productId, current);
	}

	const hydratedSkusByProductEntries = await Promise.all(
		productIds.map(async (productId) => {
			const product = productsById.get(productId);
			const skus = skusByProduct.get(productId) ?? [];
			const hydratedSkus = product ? await hydrateSkusWithInventoryStock(product, skus, collections.inventoryStock) : [];
			return [productId, hydratedSkus] as const;
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

export function summarizeInventory(skus: StoredProductSku[]) {
	const skuCount = skus.length;
	const activeSkus = skus.filter((sku) => sku.status === "active");
	const activeSkuCount = activeSkus.length;
	const totalInventoryQuantity = skus.reduce((total, sku) => total + sku.inventoryQuantity, 0);
	return { skuCount, activeSkuCount, totalInventoryQuantity };
}

export function summarizeSkuPricing(skus: StoredProductSku[]) {
	if (skus.length === 0) return { minUnitPriceMinor: undefined, maxUnitPriceMinor: undefined };
	const prices = skus.filter((sku) => sku.status === "active").map((sku) => sku.unitPriceMinor);
	if (prices.length === 0) {
		return { minUnitPriceMinor: undefined, maxUnitPriceMinor: undefined };
	}
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	return { minUnitPriceMinor: min, maxUnitPriceMinor: max };
}

export async function collectLinkedProductIds(
	links: Collection<{ productId: string }>,
	where: Record<string, string>,
): Promise<Set<string>> {
	const ids = new Set<string>();
	let cursor: string | undefined;
	while (true) {
		const result = await links.query({ where, cursor, limit: 100 });
		for (const row of result.items) {
			ids.add(row.data.productId);
		}
		if (!result.hasMore || !result.cursor) {
			break;
		}
		cursor = result.cursor;
	}
	return ids;
}

export async function queryCategoryDtosForProducts(
	productCategoryLinks: Collection<StoredProductCategoryLink>,
	categories: Collection<StoredCategory>,
	productIds: string[],
): Promise<Map<string, ProductCategoryDTO[]>> {
	const normalizedProductIds = toUniqueStringList(productIds);
	if (normalizedProductIds.length === 0) {
		return new Map();
	}

	const links = await queryAllPages((cursor) =>
		productCategoryLinks.query({
			where: { productId: { in: normalizedProductIds } },
			cursor,
			limit: 100,
		}),
	);
	const categoryRows = await getManyByIds(
		categories,
		toUniqueStringList(links.map((link) => link.data.categoryId)),
	);
	const rowsByProduct = new Map<string, ProductCategoryDTO[]>();

	for (const link of links) {
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

export async function queryTagDtosForProducts(
	productTagLinks: Collection<StoredProductTagLink>,
	tags: Collection<StoredProductTag>,
	productIds: string[],
): Promise<Map<string, ProductTagDTO[]>> {
	const normalizedProductIds = toUniqueStringList(productIds);
	if (normalizedProductIds.length === 0) {
		return new Map();
	}

	const links = await queryAllPages((cursor) =>
		productTagLinks.query({
			where: { productId: { in: normalizedProductIds } },
			cursor,
			limit: 100,
		}),
	);
	const tagRows = await getManyByIds(tags, toUniqueStringList(links.map((link) => link.data.tagId)));
	const rowsByProduct = new Map<string, ProductTagDTO[]>();

	for (const link of links) {
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

export async function queryProductImagesByRoleForTargets(
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
	const links = await queryAllPages((cursor) =>
		productAssetLinks.query({
			...query,
			cursor,
			limit: 100,
		}),
	);
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

export async function querySkuOptionValuesBySkuIds(
	productSkuOptionValues: Collection<StoredProductSkuOptionValue>,
	skuIds: string[],
): Promise<Map<string, Array<{ attributeId: string; attributeValueId: string }>>> {
	const normalizedSkuIds = toUniqueStringList(skuIds);
	if (normalizedSkuIds.length === 0) {
		return new Map();
	}

	const rows = await queryAllPages((cursor) =>
		productSkuOptionValues.query({
			where: { skuId: { in: normalizedSkuIds } },
			cursor,
			limit: 100,
		}),
	);
	const bySkuId = new Map<string, Array<{ attributeId: string; attributeValueId: string }>>();
	for (const row of rows) {
		const current = bySkuId.get(row.data.skuId) ?? [];
		current.push({
			attributeId: row.data.attributeId,
			attributeValueId: row.data.attributeValueId,
		});
		bySkuId.set(row.data.skuId, current);
	}
	return bySkuId;
}

export async function queryDigitalEntitlementSummariesBySkuIds(
	productDigitalEntitlements: Collection<StoredDigitalEntitlement>,
	productDigitalAssets: Collection<StoredDigitalAsset>,
	skuIds: string[],
): Promise<Map<string, ProductDigitalEntitlementSummaryRow[]>> {
	const normalizedSkuIds = toUniqueStringList(skuIds);
	if (normalizedSkuIds.length === 0) {
		return new Map();
	}

	const entitlementRows = await queryAllPages((cursor) =>
		productDigitalEntitlements.query({
			where: { skuId: { in: normalizedSkuIds } },
			cursor,
			limit: 100,
		}),
	);
	const assetIds = toUniqueStringList(entitlementRows.map((row) => row.data.digitalAssetId));
	const assetsById = await getManyByIds(productDigitalAssets, assetIds);
	const summariesBySku = new Map<string, ProductDigitalEntitlementSummaryRow[]>();
	for (const entitlement of entitlementRows) {
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

export function hydrateSkusWithInventoryStock(
	product: StoredProduct,
	skuRows: StoredProductSku[],
	inventoryStock: Collection<StoredInventoryStock> | null,
): Promise<StoredProductSku[]> {
	if (!inventoryStock) {
		return Promise.resolve(skuRows);
	}

	return Promise.all(
		skuRows.map(async (sku) => {
			const variantStock = await inventoryStock.get(inventoryStockDocId(product.id, sku.id));
			const productLevelStock = product.type === "simple" && skuRows.length === 1
				? await inventoryStock.get(inventoryStockDocId(product.id, ""))
				: null;
			const stock = variantStock ?? productLevelStock;
			if (!stock) {
				return sku;
			}
			return {
				...sku,
				inventoryQuantity: stock.quantity,
				inventoryVersion: stock.version,
			};
		}),
	);
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

interface Collection<T> {
	get: (id: string) => Promise<T | null>;
	query: (options: Record<string, unknown>) => Promise<{ items: Array<{ id: string; data: T }>; hasMore: boolean; cursor?: string }>;
}

