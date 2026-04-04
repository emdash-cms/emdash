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
import { randomHex } from "../lib/crypto-adapter.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import type {
	ProductAssetLinkTarget,
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
	ProductStateInput,
	ProductUpdateInput,
	ProductSkuListInput,
} from "../schemas.js";
import type {
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductSku,
} from "../types.js";

type Collection<T> = StorageCollection<T>;

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

export type ProductResponse = {
	product: StoredProduct;
};

export type ProductListResponse = {
	items: StoredProduct[];
};

export type ProductSkuResponse = {
	sku: StoredProductSku;
};

export type ProductSkuListResponse = {
	items: StoredProductSku[];
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

function sortAssetLinksByPosition(links: StoredProductAssetLink[]): StoredProductAssetLink[] {
	const sorted = [...links].sort((left, right) => {
		if (left.position === right.position) {
			return left.createdAt.localeCompare(right.createdAt);
		}
		return left.position - right.position;
	});
	return sorted;
}

export async function createProductHandler(ctx: RouteContext<ProductCreateInput>): Promise<ProductResponse> {
	requirePost(ctx);

	const products = asCollection<StoredProduct>(ctx.storage.products);
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
	const status = ctx.input.status;
	const product: StoredProduct = {
		id,
		type: ctx.input.type,
		status,
		visibility: ctx.input.visibility,
		slug: ctx.input.slug,
		title: ctx.input.title,
		shortDescription: ctx.input.shortDescription,
		longDescription: ctx.input.longDescription,
		brand: ctx.input.brand,
		vendor: ctx.input.vendor,
		featured: ctx.input.featured,
		sortOrder: ctx.input.sortOrder,
		requiresShippingDefault: ctx.input.requiresShippingDefault,
		taxClassDefault: ctx.input.taxClassDefault,
		metadataJson: {},
		createdAt: nowIso,
		updatedAt: nowIso,
		publishedAt: status === "active" ? nowIso : undefined,
		archivedAt: status === "archived" ? nowIso : undefined,
	};

	await products.put(id, product);
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

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	return { product };
}

export async function listProductsHandler(ctx: RouteContext<ProductListInput>): Promise<ProductListResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const where = toWhere(ctx.input);

	const result = await products.query({
		where,
		limit: ctx.input.limit,
	});

	const items = result.items
		.map((row) => row.data)
		.sort((left, right) => left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug));

	return { items };
}

export async function createProductSkuHandler(
	ctx: RouteContext<ProductSkuCreateInput>,
): Promise<ProductSkuResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);

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

	const nowIso = new Date(Date.now()).toISOString();
	const id = `sku_${ctx.input.productId}_${await randomHex(6)}`;
	const sku: StoredProductSku = {
		id,
		productId: ctx.input.productId,
		skuCode: ctx.input.skuCode,
		status: ctx.input.status,
		unitPriceMinor: ctx.input.unitPriceMinor,
		compareAtPriceMinor: ctx.input.compareAtPriceMinor,
		inventoryQuantity: ctx.input.inventoryQuantity,
		inventoryVersion: ctx.input.inventoryVersion,
		requiresShipping: ctx.input.requiresShipping,
		isDigital: ctx.input.isDigital,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	await productSkus.put(id, sku);
	return { sku };
}

export async function updateProductSkuHandler(
	ctx: RouteContext<ProductSkuUpdateInput>,
): Promise<ProductSkuResponse> {
	requirePost(ctx);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const nowIso = new Date(Date.now()).toISOString();

	const existing = await productSkus.get(ctx.input.skuId);
	if (!existing) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}

	const { skuId, ...patch } = ctx.input;
	const sku = applyProductSkuUpdatePatch(existing, patch, nowIso);
	await productSkus.put(skuId, sku);

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
	if (ctx.input.role === "primary_image") {
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
	const desiredPosition = normalizeAssetPosition(ctx.input.position);
	const requestedPosition = Math.min(desiredPosition, links.length);

	const link: StoredProductAssetLink = {
		id: linkId,
		targetType,
		targetId,
		assetId: ctx.input.assetId,
		role: ctx.input.role,
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

	await productAssetLinks.delete(ctx.input.linkId);
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
