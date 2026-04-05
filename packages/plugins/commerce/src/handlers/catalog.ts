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
import { inventoryStockDocId } from "../orchestration/finalize-payment-inventory.js";
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

function sortAssetLinksByPosition(links: StoredProductAssetLink[]): StoredProductAssetLink[] {
	const sorted = sortedImmutable(links, (left, right) => {
		if (left.position === right.position) {
			return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
		}
		return left.position - right.position;
	});
	return sorted;
}

function sortBundleComponentsByPosition(
	components: StoredBundleComponent[],
): StoredBundleComponent[] {
	const sorted = sortedImmutable(components, (left, right) => {
		if (left.position === right.position) {
			return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
		}
		return left.position - right.position;
	});
	return sorted;
}

function normalizeBundleComponentPositions(
	components: StoredBundleComponent[],
): StoredBundleComponent[] {
	return components.map((component, idx) => ({
		...component,
		position: idx,
	}));
}

async function queryBundleComponentsForProduct(
	bundleComponents: Collection<StoredBundleComponent>,
	bundleProductId: string,
): Promise<StoredBundleComponent[]> {
	const query = await bundleComponents.query({
		where: { bundleProductId },
	});
	const rows = sortBundleComponentsByPosition(query.items.map((row) => row.data));
	return normalizeBundleComponentPositions(rows);
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

async function queryCategoryDtos(
	productCategoryLinks: Collection<StoredProductCategoryLink>,
	categories: Collection<StoredCategory>,
	productId: string,
): Promise<ProductCategoryDTO[]> {
	const links = await productCategoryLinks.query({
		where: { productId },
	});
	const rows = await Promise.all(
		links.items.map(async (link) => {
			const category = await categories.get(link.data.categoryId);
			return category ? toProductCategoryDTO(category) : null;
		}),
	);
	return rows.filter((row): row is ProductCategoryDTO => row !== null);
}

async function queryTagDtos(
	productTagLinks: Collection<StoredProductTagLink>,
	tags: Collection<StoredProductTag>,
	productId: string,
): Promise<ProductTagDTO[]> {
	const links = await productTagLinks.query({
		where: { productId },
	});
	const rows = await Promise.all(
		links.items.map(async (link) => {
			const tag = await tags.get(link.data.tagId);
			return tag ? toProductTagDTO(tag) : null;
		}),
	);
	return rows.filter((row): row is ProductTagDTO => row !== null);
}

function summarizeInventory(skus: StoredProductSku[]): ProductInventorySummaryDTO {
	const skuCount = skus.length;
	const activeSkus = skus.filter((sku) => sku.status === "active");
	const activeSkuCount = activeSkus.length;
	const totalInventoryQuantity = skus.reduce((total, sku) => total + sku.inventoryQuantity, 0);
	return { skuCount, activeSkuCount, totalInventoryQuantity };
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

async function queryPrimaryImageForProduct(
	productAssetLinks: Collection<StoredProductAssetLink>,
	productAssets: Collection<StoredProductAsset>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
): Promise<ProductPrimaryImageDTO | undefined> {
	const images = await queryProductImagesByRole(productAssetLinks, productAssets, targetType, targetId, ["primary_image"]);
	return images[0];
}

async function queryProductImagesByRole(
	productAssetLinks: Collection<StoredProductAssetLink>,
	productAssets: Collection<StoredProductAsset>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
	roles: ProductAssetRole[],
): Promise<ProductPrimaryImageDTO[]> {
	const links = await queryAssetLinksForTarget(productAssetLinks, targetType, targetId);
	const rows: ProductPrimaryImageDTO[] = [];
	for (const link of links) {
		if (!roles.includes(link.role)) continue;
		const asset = await productAssets.get(link.assetId);
		if (!asset) continue;
		rows.push({
			linkId: link.id,
			assetId: asset.id,
			provider: asset.provider,
			externalAssetId: asset.externalAssetId,
			fileName: asset.fileName,
			altText: asset.altText,
		});
	}
	return rows;
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
	const skusResult = await productSkus.query({ where: { productId: product.id } });
	const skuRows = await hydrateSkusWithInventoryStock(
		product,
		skusResult.items.map((row) => row.data),
		inventoryStock,
	);
	const categories = await queryCategoryDtos(productCategoryLinks, productCategories, product.id);
	const tags = await queryTagDtos(productTagLinks, productTags, product.id);
	const primaryImage = await queryPrimaryImageForProduct(productAssetLinks, productAssets, "product", product.id);
	const galleryImages = await queryProductImagesByRole(
		productAssetLinks,
		productAssets,
		"product",
		product.id,
		["gallery_image"],
	);
	const response: ProductResponse = { product, skus: skuRows, categories, tags };
	if (primaryImage) response.primaryImage = primaryImage;
	if (galleryImages.length > 0) response.galleryImages = galleryImages;

	if (product.type === "variable") {
		const attributes = (await productAttributes.query({ where: { productId: product.id } })).items.map(
			(row) => row.data,
		);
		const variantMatrix: VariantMatrixDTO[] = [];
		for (const skuRow of skuRows) {
			const optionResult = await productSkuOptionValues.query({ where: { skuId: skuRow.id } });
			const variantImage = (await queryProductImagesByRole(productAssetLinks, productAssets, "sku", skuRow.id, [
				"variant_image",
			]))[0];
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
				options: optionResult.items.map((option) => ({
					attributeId: option.data.attributeId,
					attributeValueId: option.data.attributeValueId,
				})),
			});
		}
		response.attributes = attributes;
		response.variantMatrix = variantMatrix;
	}

	if (product.type === "bundle") {
		const components = await queryBundleComponentsForProduct(bundleComponents, product.id);
		const componentLines = [];
		for (const component of components) {
			const componentSku = await productSkus.get(component.componentSkuId);
			if (!componentSku) {
				throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "Bundle component SKU not found" });
			}
			const componentProduct = await products.get(componentSku.productId);
			if (!componentProduct) {
				throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle component product not found" });
			}
			const hydratedComponentSkus = await hydrateSkusWithInventoryStock(
				componentProduct,
				[componentSku],
				inventoryStock,
			);
			componentLines.push({ component, sku: hydratedComponentSkus[0] ?? componentSku });
		}
		response.bundleSummary = computeBundleSummary(
			product.id,
			product.bundleDiscountType,
			product.bundleDiscountValueMinor,
			product.bundleDiscountValueBps,
			componentLines,
		);
	}

	const digitalEntitlements: ProductDigitalEntitlementSummary[] = [];
	for (const sku of skuRows) {
		const entitlementResult = await productDigitalEntitlements.query({
			where: { skuId: sku.id },
			limit: 100,
		});
		if (entitlementResult.items.length === 0) {
			continue;
		}

		const entitlements = [];
		for (const entitlementRow of entitlementResult.items) {
			const entitlement = entitlementRow.data;
			const digitalAsset = await productDigitalAssets.get(entitlement.digitalAssetId);
			if (!digitalAsset) {
				continue;
			}
			entitlements.push({
				entitlementId: entitlement.id,
				digitalAssetId: entitlement.digitalAssetId,
				digitalAssetLabel: digitalAsset.label,
				grantedQuantity: entitlement.grantedQuantity,
				downloadLimit: digitalAsset.downloadLimit,
				downloadExpiryDays: digitalAsset.downloadExpiryDays,
				isManualOnly: digitalAsset.isManualOnly,
				isPrivate: digitalAsset.isPrivate,
			});
		}
		if (entitlements.length > 0) {
			digitalEntitlements.push({
				skuId: sku.id,
				entitlements,
			});
		}
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
	const items: CatalogListingDTO[] = [];
	for (const row of sortedRows) {
		const skus = await productSkus.query({ where: { productId: row.id } });
		const skuRows = await hydrateSkusWithInventoryStock(
			row,
			skus.items.map((sku) => sku.data),
			inventoryStock,
		);
		const primaryImage = await queryPrimaryImageForProduct(productAssetLinks, productAssets, "product", row.id);
		const galleryImages = await queryProductImagesByRole(
			productAssetLinks,
			productAssets,
			"product",
			row.id,
			["gallery_image"],
		);
		const categories = await queryCategoryDtos(productCategoryLinks, productCategories, row.id);
		const tags = await queryTagDtos(productTagLinks, productTags, row.id);
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

function normalizeAssetPosition(input: number): number {
	return Math.max(0, Math.trunc(input));
}

async function queryAssetLinksForTarget(
	productAssetLinks: Collection<StoredProductAssetLink>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
): Promise<StoredProductAssetLink[]> {
	const result = await productAssetLinks.query({ where: { targetType, targetId } });
	return sortAssetLinksByPosition(result.items.map((row) => row.data));
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
	const desiredPosition = normalizeAssetPosition(position);
	const requestedPosition = Math.min(desiredPosition, links.length);

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

	const nextOrder = [...links];
	nextOrder.splice(requestedPosition, 0, link);
	const normalized = normalizeAssetLinks(nextOrder);

	for (const candidate of normalized) {
		await productAssetLinks.put(candidate.id, {
			...candidate,
			updatedAt: nowIso,
		});
	}

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
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const existing = await productAssetLinks.get(ctx.input.linkId);
	if (!existing) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Asset link not found" });
	}
	const links = await queryAssetLinksForTarget(productAssetLinks, existing.targetType, existing.targetId);

	await productAssetLinks.delete(ctx.input.linkId);

	const remaining = links.filter((link) => link.id !== ctx.input.linkId);
	const normalized = normalizeAssetLinks(remaining).map((link) => ({
		...link,
		updatedAt: new Date(Date.now()).toISOString(),
	}));
	for (const candidate of normalized) {
		await productAssetLinks.put(candidate.id, candidate);
	}

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
	const requestedPosition = normalizeAssetPosition(ctx.input.position);
	const fromIndex = links.findIndex((candidate) => candidate.id === ctx.input.linkId);
	if (fromIndex === -1) {
		throw PluginRouteError.badRequest("Asset link not found in target links");
	}

	const nextOrder = [...links];
	const [moving] = nextOrder.splice(fromIndex, 1);
	if (!moving) {
		throw PluginRouteError.badRequest("Asset link not found in target links");
	}

	const targetIndex = Math.min(requestedPosition, nextOrder.length);
	nextOrder.splice(targetIndex, 0, moving);
	const normalized = normalizeAssetLinksByOrder(nextOrder).map((candidate) => ({
		...candidate,
		updatedAt: nowIso,
	}));

	for (const candidate of normalized) {
		await productAssetLinks.put(candidate.id, candidate);
	}

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
	const desiredPosition = Math.max(0, Math.min(ctx.input.position, existingComponents.length));
	const componentId = `bundle_comp_${await randomHex(6)}`;
	const component: StoredBundleComponent = {
		id: componentId,
		bundleProductId: bundleProduct.id,
		componentSkuId: componentSku.id,
		quantity: ctx.input.quantity,
		position: desiredPosition,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	const nextOrder = [...existingComponents];
	nextOrder.splice(desiredPosition, 0, component);
	const normalized = normalizeBundleComponentPositions(nextOrder).map((candidate) => ({
		...candidate,
		updatedAt: nowIso,
	}));

	for (const candidate of normalized) {
		await bundleComponents.put(candidate.id, candidate);
	}

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
	const remaining = components.filter((row) => row.id !== ctx.input.bundleComponentId);
	const normalized = normalizeBundleComponentPositions(remaining).map((candidate) => ({
		...candidate,
		updatedAt: nowIso,
	}));

	await bundleComponents.delete(ctx.input.bundleComponentId);
	for (const candidate of normalized) {
		await bundleComponents.put(candidate.id, candidate);
	}
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
	const fromIndex = components.findIndex((row) => row.id === ctx.input.bundleComponentId);
	if (fromIndex === -1) {
		throw PluginRouteError.badRequest("Bundle component not found in target bundle");
	}

	const targetPosition = Math.max(0, Math.min(ctx.input.position, components.length - 1));

	const nextOrder = [...components];
	const [moving] = nextOrder.splice(fromIndex, 1);
	if (!moving) {
		throw PluginRouteError.badRequest("Bundle component not found in target bundle");
	}

	const insertionIndex = Math.min(targetPosition, nextOrder.length);
	nextOrder.splice(insertionIndex, 0, moving);
	const normalized = normalizeBundleComponentPositions(nextOrder).map((candidate) => ({
		...candidate,
		updatedAt: nowIso,
	}));

	for (const candidate of normalized) {
		await bundleComponents.put(candidate.id, candidate);
	}

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

function normalizeAssetLinks(links: StoredProductAssetLink[]): StoredProductAssetLink[] {
	const sorted = sortAssetLinksByPosition(links);
	return sorted.map((link, idx) => ({
		...link,
		position: idx,
	}));
}

function normalizeAssetLinksByOrder(links: StoredProductAssetLink[]): StoredProductAssetLink[] {
	return links.map((link, idx) => ({
		...link,
		position: idx,
	}));
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
