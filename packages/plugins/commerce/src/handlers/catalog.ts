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
	ProductCreateInput,
	ProductSkuStateInput,
	ProductSkuUpdateInput,
	ProductGetInput,
	ProductListInput,
	ProductSkuCreateInput,
	ProductStateInput,
	ProductUpdateInput,
	ProductSkuListInput,
} from "../schemas.js";
import type { StoredProduct, StoredProductSku } from "../types.js";

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
