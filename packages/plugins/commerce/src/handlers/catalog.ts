/**
 * Catalog management handlers for commerce plugin v1 foundation.
 *
 * This file implements the Phase 1 foundation slice from the catalog
 * specification: products and product SKUs with basic write/read paths and
 * invariant checks for catalog mutability and uniqueness constraints.
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import {
	applyProductUpdatePatch,
	applyProductSkuUpdatePatch,
	applyProductStatusTransition,
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
import {
	mutateOrderedChildren,
	normalizeOrderedChildren,
	normalizeOrderedPosition,
	sortOrderedRowsByPosition,
} from "../lib/ordered-rows.js";
import {
	queryAllPages,
	queryDigitalEntitlementSummariesBySkuIds,
	queryProductImagesByRoleForTargets,
	querySkuOptionValuesBySkuIds,
	getManyByIds,
	hydrateSkusWithInventoryStock,
	loadProductReadMetadata,
	loadProductsReadMetadata,
	summarizeInventory,
	summarizeSkuPricing,
	toUniqueStringList,
} from "./catalog-read-model.js";
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
function getNowIso(): string {
	return new Date(Date.now()).toISOString();
}

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

type CollectionWithUniqueInsert<T> = Collection<T> & {
	putIfAbsent?: (id: string, data: T) => Promise<boolean>;
};

type ConflictHint = {
	where: Record<string, unknown>;
	message: string;
};

function looksLikeUniqueConstraintMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("unique constraint failed") ||
		normalized.includes("uniqueness violation") ||
		normalized.includes("duplicate key value violates unique constraint") ||
		normalized.includes("duplicate entry") ||
		normalized.includes("constraint failed:") ||
		normalized.includes("sqlerrorcode=primarykey")
	);
}

function readErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const maybeCode = (error as Record<string, unknown>).code;
	if (typeof maybeCode === "string" && maybeCode.length > 0) {
		return maybeCode;
	}
	if (typeof maybeCode === "number") {
		return String(maybeCode);
	}
	const maybeCause = (error as Record<string, unknown>).cause;
	return typeof maybeCause === "object" ? readErrorCode(maybeCause) : undefined;
}

function isUniqueConstraintViolation(error: unknown, seen = new Set<unknown>()): boolean {
	if (error == null || seen.has(error)) return false;
	seen.add(error);

	if (readErrorCode(error) === "23505") return true;

	if (error instanceof Error) {
		if (looksLikeUniqueConstraintMessage(error.message)) return true;
		return isUniqueConstraintViolation((error as Error & { cause?: unknown }).cause, seen);
	}

	if (typeof error === "object") {
		const record = error as Record<string, unknown>;
		const message = record.message;
		if (typeof message === "string" && looksLikeUniqueConstraintMessage(message)) return true;
		const cause = record.cause;
		if (cause) {
			return isUniqueConstraintViolation(cause, seen);
		}
	}

	return false;
}

async function assertNoConflict<T extends object>(
	collection: Collection<T>,
	where: Record<string, unknown>,
	excludeId?: string,
	message?: string,
): Promise<void> {
	const result = await collection.query({ where, limit: 2 });
	for (const item of result.items) {
		if (item.id !== excludeId) {
			throwConflict(message ?? "Resource already exists");
		}
	}
}

function throwConflict(message: string): never {
	throw PluginRouteError.badRequest(message);
}

async function putWithConflictHandling<T extends object>(
	collection: CollectionWithUniqueInsert<T>,
	id: string,
	data: T,
	conflict?: ConflictHint,
): Promise<void> {
	if (collection.putIfAbsent) {
		try {
			const inserted = await collection.putIfAbsent(id, data);
			if (!inserted) {
				throwConflict(conflict?.message ?? "Resource already exists");
			}
			return;
		} catch (error) {
			if (isUniqueConstraintViolation(error) && conflict) {
				throwConflict(conflict.message);
			}
			throw error;
		}
	}

	if (conflict) {
		await assertNoConflict(collection, conflict.where, undefined, conflict.message);
	}
	await collection.put(id, data);
}

async function putWithUpdateConflictHandling<T extends object>(
	collection: CollectionWithUniqueInsert<T>,
	id: string,
	data: T,
	conflict?: ConflictHint,
): Promise<void> {
	if (conflict && !collection.putIfAbsent) {
		await assertNoConflict(collection, conflict.where, id, conflict.message);
	}

	try {
		await collection.put(id, data);
		return;
	} catch (error) {
		if (isUniqueConstraintViolation(error) && conflict) {
			throwConflict(conflict.message);
		}
		throw error;
	}
}

function asOptionalCollection<T>(raw: unknown): Collection<T> | null {
	return raw ? (raw as Collection<T>) : null;
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

function toStorefrontProductRecord(product: StoredProduct): StorefrontProductRecord {
	return {
		id: product.id,
		type: product.type,
		status: product.status,
		visibility: product.visibility,
		slug: product.slug,
		title: product.title,
		shortDescription: product.shortDescription,
		brand: product.brand,
		vendor: product.vendor,
		featured: product.featured,
		sortOrder: product.sortOrder,
		requiresShippingDefault: product.requiresShippingDefault,
		taxClassDefault: product.taxClassDefault,
		bundleDiscountType: product.bundleDiscountType,
		bundleDiscountValueMinor: product.bundleDiscountValueMinor,
		bundleDiscountValueBps: product.bundleDiscountValueBps,
		createdAt: product.createdAt,
		updatedAt: product.updatedAt,
	};
}

function resolveProductAvailability(quantity: number): StorefrontProductAvailability {
	if (quantity <= 0) {
		return "out_of_stock";
	}
	if (quantity <= COMMERCE_LIMITS.lowStockThreshold) {
		return "low_stock";
	}
	return "in_stock";
}

function assertStorefrontProductVisible(product: StoredProduct): void {
	if (product.status !== "active" || product.visibility !== "public") {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not available" });
	}
}

function normalizeStorefrontProductListInput(input: ProductListInput): ProductListInput {
	return {
		...input,
		status: "active",
		visibility: "public",
	};
}

function toStorefrontSkuSummary(sku: StoredProductSku): StorefrontSkuSummary {
	return {
		id: sku.id,
		productId: sku.productId,
		skuCode: sku.skuCode,
		status: sku.status,
		unitPriceMinor: sku.unitPriceMinor,
		compareAtPriceMinor: sku.compareAtPriceMinor,
		requiresShipping: sku.requiresShipping,
		isDigital: sku.isDigital,
		availability: resolveProductAvailability(sku.inventoryQuantity),
	};
}

function toStorefrontVariantMatrixRow(row: VariantMatrixDTO): StorefrontVariantMatrixRow {
	const { inventoryQuantity } = row;
	const sanitized = row as Omit<VariantMatrixDTO, "inventoryQuantity" | "inventoryVersion">;
	return {
		...sanitized,
		availability: resolveProductAvailability(inventoryQuantity),
	};
}

function toStorefrontProductDetail(response: ProductResponse): StorefrontProductDetail {
	return {
		product: toStorefrontProductRecord(response.product),
		skus: response.skus?.map(toStorefrontSkuSummary),
		attributes: response.attributes,
		variantMatrix: response.variantMatrix?.map(toStorefrontVariantMatrixRow),
		categories: response.categories ?? [],
		tags: response.tags ?? [],
		primaryImage: response.primaryImage,
		galleryImages: response.galleryImages,
	};
}

function toStorefrontProductListResponse(response: ProductListResponse): StorefrontProductListResponse {
	return {
		items: response.items.map((item) => ({
			product: toStorefrontProductRecord(item.product),
			priceRange: item.priceRange,
			availability: resolveProductAvailability(item.inventorySummary.totalInventoryQuantity),
			primaryImage: item.primaryImage,
			galleryImages: item.galleryImages,
			lowStockSkuCount: item.lowStockSkuCount,
			categories: item.categories,
			tags: item.tags,
		})),
	};
}

function toStorefrontBundleComputeResponse(response: BundleComputeSummary): StorefrontBundleComputeResponse {
	return {
		productId: response.productId,
		subtotalMinor: response.subtotalMinor,
		discountType: response.discountType,
		discountValueMinor: response.discountValueMinor,
		discountValueBps: response.discountValueBps,
		discountAmountMinor: response.discountAmountMinor,
		finalPriceMinor: response.finalPriceMinor,
		availability: response.availability,
		components: response.components.map((component) => ({
			componentId: component.componentId,
			componentSkuCode: component.componentSkuCode,
			componentPriceMinor: component.componentPriceMinor,
			quantityPerBundle: component.quantityPerBundle,
			subtotalContributionMinor: component.subtotalContributionMinor,
			availableBundleQuantity: component.availableBundleQuantity,
		})),
	};
}

function intersectProductIdSets(left: Set<string>, right: Set<string>): Set<string> {
	if (left.size > right.size) {
		const swapped = left;
		left = right;
		right = swapped;
	}
	const result = new Set<string>();
	for (const value of left) {
		if (right.has(value)) {
			result.add(value);
		}
	}
	return result;
}

async function collectLinkedProductIds(
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

export type StorefrontBundleComputeComponentSummary = Omit<BundleComputeSummary["components"][number], "componentSkuId" | "componentProductId">;

export type StorefrontBundleComputeResponse = Omit<BundleComputeSummary, "components"> & {
	components: StorefrontBundleComputeComponentSummary[];
};

export type ProductListResponse = {
	items: CatalogListingDTO[];
};

export type StorefrontProductAvailability = "in_stock" | "low_stock" | "out_of_stock";

export type StorefrontProductRecord = {
	id: string;
	type: StoredProduct["type"];
	status: StoredProduct["status"];
	visibility: StoredProduct["visibility"];
	slug: string;
	title: string;
	shortDescription: string;
	brand?: string;
	vendor?: string;
	featured: boolean;
	sortOrder: number;
	requiresShippingDefault: boolean;
	taxClassDefault?: string;
	bundleDiscountType?: StoredProduct["bundleDiscountType"];
	bundleDiscountValueMinor?: number;
	bundleDiscountValueBps?: number;
	createdAt: string;
	updatedAt: string;
};

export type StorefrontVariantMatrixRow = Omit<VariantMatrixDTO, "inventoryQuantity" | "inventoryVersion"> & {
	availability: StorefrontProductAvailability;
};

export type StorefrontSkuSummary = {
	id: string;
	productId: string;
	skuCode: string;
	status: StoredProductSku["status"];
	unitPriceMinor: number;
	compareAtPriceMinor?: number;
	requiresShipping: boolean;
	isDigital: boolean;
	availability: StorefrontProductAvailability;
};

export type StorefrontProductDetail = {
	product: StorefrontProductRecord;
	skus?: StorefrontSkuSummary[];
	attributes?: StoredProductAttribute[];
	variantMatrix?: StorefrontVariantMatrixRow[];
	categories: ProductCategoryDTO[];
	tags: ProductTagDTO[];
	primaryImage?: ProductPrimaryImageDTO;
	galleryImages?: ProductPrimaryImageDTO[];
};

export type StorefrontProductListResponse = {
	items: Array<
		Omit<CatalogListingDTO, "product" | "inventorySummary"> & {
			product: StorefrontProductRecord;
			availability?: StorefrontProductAvailability;
		}
	>;
};

export type StorefrontSkuListResponse = {
	items: StorefrontSkuSummary[];
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

async function queryBundleComponentsForProduct(
	bundleComponents: Collection<StoredBundleComponent>,
	bundleProductId: string,
): Promise<StoredBundleComponent[]> {
	const links = await queryAllPages((cursor) =>
		bundleComponents.query({
			where: { bundleProductId },
			cursor,
			limit: 100,
		}),
	);
	const rows = sortOrderedRowsByPosition(links.map((row) => row.data));
	return normalizeOrderedChildren(rows);
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

	await putWithConflictHandling(products, id, product, {
		where: { slug: ctx.input.slug },
		message: `Product slug already exists: ${ctx.input.slug}`,
	});

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
	const nowIso = getNowIso();

	const existing = await products.get(ctx.input.productId);
	if (!existing) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const { productId, ...patch } = ctx.input;
	assertBundleDiscountPatchForProduct(existing, patch);

	const product = applyProductUpdatePatch(existing, patch, nowIso);
	const conflict = patch.slug !== undefined ? {
		where: { slug: patch.slug },
		message: `Product slug already exists: ${patch.slug}`,
	} : undefined;
	await putWithUpdateConflictHandling(products, productId, product, conflict);
	return { product };
}

export async function setProductStateHandler(ctx: RouteContext<ProductStateInput>): Promise<ProductResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const nowIso = getNowIso();

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}

	const updated = applyProductStatusTransition(product, ctx.input.status, nowIso);
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
	const hasProductAttributeFilter = Object.keys(where).length > 0;

	let rows: StoredProduct[] = [];
	if (includeCategoryId || includeTagId) {
		let filteredProductIds: Set<string> | null = null;
		if (includeCategoryId) {
			filteredProductIds = await collectLinkedProductIds(productCategoryLinks, { categoryId: includeCategoryId });
		}
		if (includeTagId) {
			const tagProductIds = await collectLinkedProductIds(productTagLinks, { tagId: includeTagId });
			filteredProductIds = filteredProductIds
				? intersectProductIdSets(filteredProductIds, tagProductIds)
				: tagProductIds;
		}
		if (!filteredProductIds || filteredProductIds.size === 0) {
			return { items: [] };
		}

		if (!hasProductAttributeFilter) {
			const rowsById = await getManyByIds(products, [...filteredProductIds]);
			rows = [...rowsById.values()];
		} else {
			let cursor: string | undefined;
			while (true) {
				const result = await products.query({ where, cursor, limit: 100 });
				for (const row of result.items) {
					if (filteredProductIds.has(row.id)) {
						rows.push(row.data);
					}
				}
				if (!result.hasMore || !result.cursor) {
					break;
				}
				cursor = result.cursor;
			}
		}
	} else {
		const result = await queryAllPages((cursor) =>
			products.query({
				where,
				cursor,
				limit: 100,
			}),
		);
		rows = result.map((row) => row.data);
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
	const nowIso = getNowIso();

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
	await putWithConflictHandling(categories, id, category, {
		where: { slug: ctx.input.slug },
		message: `Category slug already exists: ${ctx.input.slug}`,
	});
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
	const nowIso = getNowIso();

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const category = await categories.get(ctx.input.categoryId);
	if (!category) {
		throw PluginRouteError.badRequest(`Category not found: ${ctx.input.categoryId}`);
	}

	const id = `prod_cat_link_${await randomHex(6)}`;
	const link: StoredProductCategoryLink = {
		id,
		productId: ctx.input.productId,
		categoryId: ctx.input.categoryId,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await putWithConflictHandling(productCategoryLinks, id, link, {
		where: {
			productId: ctx.input.productId,
			categoryId: ctx.input.categoryId,
		},
		message: "Product-category link already exists",
	});
	return { link };
}

export async function removeProductCategoryLinkHandler(
	ctx: RouteContext<ProductCategoryUnlinkInput>,
): Promise<ProductCategoryLinkUnlinkResponse> {
	requirePost(ctx);
	const productCategoryLinks = asCollection<StoredProductCategoryLink>(ctx.storage.productCategoryLinks);
	const link = await productCategoryLinks.get(ctx.input.linkId);
	if (!link) {
		throwCommerceApiError({ code: "CATEGORY_LINK_NOT_FOUND", message: "Product-category link not found" });
	}

	await productCategoryLinks.delete(ctx.input.linkId);
	return { deleted: true };
}

export async function createTagHandler(ctx: RouteContext<TagCreateInput>): Promise<TagResponse> {
	requirePost(ctx);
	const tags = asCollection<StoredProductTag>(ctx.storage.productTags);
	const nowIso = getNowIso();

	const id = `tag_${await randomHex(6)}`;
	const tag: StoredProductTag = {
		id,
		name: ctx.input.name,
		slug: ctx.input.slug,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await putWithConflictHandling(tags, id, tag, {
		where: { slug: ctx.input.slug },
		message: `Tag slug already exists: ${ctx.input.slug}`,
	});
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
	const nowIso = getNowIso();

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const tag = await tags.get(ctx.input.tagId);
	if (!tag) {
		throw PluginRouteError.badRequest(`Tag not found: ${ctx.input.tagId}`);
	}

	const id = `prod_tag_link_${await randomHex(6)}`;
	const link: StoredProductTagLink = {
		id,
		productId: ctx.input.productId,
		tagId: ctx.input.tagId,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await putWithConflictHandling(productTagLinks, id, link, {
		where: {
			productId: ctx.input.productId,
			tagId: ctx.input.tagId,
		},
		message: "Product-tag link already exists",
	});
	return { link };
}

export async function removeProductTagLinkHandler(ctx: RouteContext<ProductTagUnlinkInput>): Promise<ProductTagLinkUnlinkResponse> {
	requirePost(ctx);
	const productTagLinks = asCollection<StoredProductTagLink>(ctx.storage.productTagLinks);
	const link = await productTagLinks.get(ctx.input.linkId);
	if (!link) {
		throwCommerceApiError({ code: "TAG_LINK_NOT_FOUND", message: "Product-tag link not found" });
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

		const attributeIds = variantAttributes.map((attribute) => attribute.id);
		const attributeValueRows = attributeIds.length === 0
			? []
			: (await productAttributeValues.query({
				where: { attributeId: { in: attributeIds } },
			})).items.map((row) => row.data);

		const existingSkuResult = await productSkus.query({ where: { productId: product.id } });
		const existingSkuIds = existingSkuResult.items.map((row) => row.data.id);
		const optionValueRows = existingSkuIds.length === 0
			? []
			: (await productSkuOptionValues.query({
				where: { skuId: { in: existingSkuIds } },
			})).items.map((row) => row.data);
		const optionValuesBySku = new Map<string, Array<{ attributeId: string; attributeValueId: string }>>();
		for (const option of optionValueRows) {
			const current = optionValuesBySku.get(option.skuId) ?? [];
			current.push({ attributeId: option.attributeId, attributeValueId: option.attributeValueId });
			optionValuesBySku.set(option.skuId, current);
		}

		const existingSignatures = new Set<string>();
		for (const row of existingSkuResult.items) {
			const options = optionValuesBySku.get(row.data.id) ?? [];
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

	const nowIso = getNowIso();
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

	await putWithConflictHandling(productSkus, id, sku, {
		where: { skuCode: ctx.input.skuCode },
		message: `SKU code already exists: ${ctx.input.skuCode}`,
	});
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
	const nowIso = getNowIso();

	const existing = await productSkus.get(ctx.input.skuId);
	if (!existing) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}

	const { skuId, ...patch } = ctx.input;
	const sku = applyProductSkuUpdatePatch(existing, patch, nowIso);
	const conflict = patch.skuCode !== undefined ? {
		where: { skuCode: patch.skuCode },
		message: `SKU code already exists: ${patch.skuCode}`,
	} : undefined;
	await putWithUpdateConflictHandling(productSkus, skuId, sku, conflict);
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
		updatedAt: getNowIso(),
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

export async function getStorefrontProductHandler(ctx: RouteContext<ProductGetInput>): Promise<StorefrontProductDetail> {
	const internal = await getProductHandler(ctx);
	assertStorefrontProductVisible(internal.product);
	return toStorefrontProductDetail(internal);
}

export async function listStorefrontProductsHandler(ctx: RouteContext<ProductListInput>): Promise<StorefrontProductListResponse> {
	const storefrontCtx = {
		...ctx,
		input: normalizeStorefrontProductListInput(ctx.input),
	} as RouteContext<ProductListInput>;
	const internal = await listProductsHandler(storefrontCtx);
	return toStorefrontProductListResponse(internal);
}

export async function listStorefrontProductSkusHandler(
	ctx: RouteContext<ProductSkuListInput>,
): Promise<StorefrontSkuListResponse> {
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	assertStorefrontProductVisible(product);
	const internal = await listProductSkusHandler(ctx);
	return {
		items: internal.items.filter((sku) => sku.status === "active").map(toStorefrontSkuSummary),
	};
}

async function queryAssetLinksForTarget(
	productAssetLinks: Collection<StoredProductAssetLink>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
): Promise<StoredProductAssetLink[]> {
	const rows = await queryAllPages((cursor) =>
		productAssetLinks.query({
			where: { targetType, targetId },
			cursor,
			limit: 100,
		}),
	);
	return normalizeOrderedChildren(sortOrderedRowsByPosition(rows.map((row) => row.data)));
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
	const nowIso = getNowIso();

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

	await putWithConflictHandling(productAssets, id, asset, {
		where: {
			provider: ctx.input.provider,
			externalAssetId: ctx.input.externalAssetId,
		},
		message: "Asset metadata already registered for provider asset key",
	});
	return { asset };
}

export async function linkCatalogAssetHandler(ctx: RouteContext<ProductAssetLinkInput>): Promise<ProductAssetLinkResponse> {
	requirePost(ctx);
	const role = ctx.input.role ?? "gallery_image";
	const position = ctx.input.position ?? 0;
	const nowIso = getNowIso();
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const skus = asCollection<StoredProductSku>(ctx.storage.productSkus);

	const targetType = ctx.input.targetType;
	const targetId = ctx.input.targetId;

	const asset = await productAssets.get(ctx.input.assetId);
	if (!asset) {
		throwCommerceApiError({ code: "ASSET_NOT_FOUND", message: "Asset not found" });
	}

	await loadCatalogTargetExists(products, skus, targetType, targetId);

	const links = await queryAssetLinksForTarget(productAssetLinks, targetType, targetId);
	if (role === "primary_image") {
		const hasPrimary = links.some((link) => link.role === "primary_image");
		if (hasPrimary) {
			throw PluginRouteError.badRequest("Target already has a primary image");
		}
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
	await putWithConflictHandling(productAssetLinks, linkId, link, {
		where: {
			targetType,
			targetId,
			assetId: ctx.input.assetId,
		},
		message: "Asset already linked to this target",
	});

	let normalized: StoredProductAssetLink[];
	try {
		normalized = await mutateOrderedChildren({
			collection: productAssetLinks,
			rows: links,
			mutation: {
				kind: "add",
				row: link,
				requestedPosition,
			},
			nowIso,
		});
	} catch (error) {
		await productAssetLinks.delete(linkId);
		throw error;
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
	const nowIso = getNowIso();
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const existing = await productAssetLinks.get(ctx.input.linkId);
	if (!existing) {
		throwCommerceApiError({ code: "ASSET_LINK_NOT_FOUND", message: "Asset link not found" });
	}
	const links = await queryAssetLinksForTarget(productAssetLinks, existing.targetType, existing.targetId);

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
	const nowIso = getNowIso();

	const link = await productAssetLinks.get(ctx.input.linkId);
	if (!link) {
		throwCommerceApiError({ code: "ASSET_LINK_NOT_FOUND", message: "Asset link not found" });
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
	const nowIso = getNowIso();

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
	await putWithConflictHandling(bundleComponents, componentId, component, {
		where: { bundleProductId: bundleProduct.id, componentSkuId: ctx.input.componentSkuId },
		message: "Bundle already contains this component SKU",
	});

	let normalized: StoredBundleComponent[];
	try {
		normalized = await mutateOrderedChildren({
			collection: bundleComponents,
			rows: existingComponents,
			mutation: {
				kind: "add",
				row: component,
				requestedPosition,
			},
			nowIso,
		});
	} catch (error) {
		await bundleComponents.delete(componentId);
		throw error;
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
	const nowIso = getNowIso();

	const existing = await bundleComponents.get(ctx.input.bundleComponentId);
	if (!existing) {
		throwCommerceApiError({ code: "BUNDLE_COMPONENT_NOT_FOUND", message: "Bundle component not found" });
	}
	const components = await queryBundleComponentsForProduct(bundleComponents, existing.bundleProductId);
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
	const nowIso = getNowIso();

	const component = await bundleComponents.get(ctx.input.bundleComponentId);
	if (!component) {
		throwCommerceApiError({ code: "BUNDLE_COMPONENT_NOT_FOUND", message: "Bundle component not found" });
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

export async function bundleComputeStorefrontHandler(
	ctx: RouteContext<BundleComputeInput>,
): Promise<StorefrontBundleComputeResponse> {
	const internal = await bundleComputeHandler(ctx);
	return toStorefrontBundleComputeResponse(internal);
}

export async function createDigitalAssetHandler(
	ctx: RouteContext<DigitalAssetCreateInput>,
): Promise<DigitalAssetResponse> {
	requirePost(ctx);
	const provider = ctx.input.provider ?? "media";
	const isManualOnly = ctx.input.isManualOnly ?? false;
	const isPrivate = ctx.input.isPrivate ?? true;
	const productDigitalAssets = asCollection<StoredDigitalAsset>(ctx.storage.digitalAssets);
	const nowIso = getNowIso();

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

	await putWithConflictHandling(productDigitalAssets, id, asset, {
		where: { provider, externalAssetId: ctx.input.externalAssetId },
		message: "Digital asset already registered for provider key",
	});
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
	const nowIso = getNowIso();

	const sku = await productSkus.get(ctx.input.skuId);
	if (!sku) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}
	if (sku.status !== "active") {
		throw PluginRouteError.badRequest(`Cannot attach entitlement to inactive SKU ${ctx.input.skuId}`);
	}

	const digitalAsset = await productDigitalAssets.get(ctx.input.digitalAssetId);
	if (!digitalAsset) {
		throwCommerceApiError({ code: "DIGITAL_ASSET_NOT_FOUND", message: "Digital asset not found" });
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
	await putWithConflictHandling(productDigitalEntitlements, id, entitlement, {
		where: { skuId: ctx.input.skuId, digitalAssetId: ctx.input.digitalAssetId },
		message: "SKU already has this digital entitlement",
	});
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
		throwCommerceApiError({ code: "DIGITAL_ENTITLEMENT_NOT_FOUND", message: "Digital entitlement not found" });
	}
	await productDigitalEntitlements.delete(ctx.input.entitlementId);
	return { deleted: true };
}
