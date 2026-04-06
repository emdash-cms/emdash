import type { RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import { applyProductSkuUpdatePatch, applyProductStatusTransition, applyProductUpdatePatch } from "../lib/catalog-domain.js";
import {
	collectVariantDefiningAttributes,
	normalizeSkuOptionSignature,
	validateVariableSkuOptions,
} from "../lib/catalog-variants.js";
import { inventoryStockDocId } from "../lib/inventory-stock.js";
import type {
	ProductCreateInput,
	ProductGetInput,
	ProductListInput,
	ProductSkuCreateInput,
	ProductSkuStateInput,
	ProductSkuUpdateInput,
	ProductSkuListInput,
	ProductStateInput,
	ProductUpdateInput,
} from "../schemas.js";
import type {
	StoredBundleComponent,
	StoredCategory,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredInventoryStock,
	StoredProduct,
	StoredProductAsset,
	StoredProductAttribute,
	StoredProductAttributeValue,
	StoredProductCategoryLink,
	StoredProductAssetLink,
	StoredProductSku,
	StoredProductSkuOptionValue,
	StoredProductTag,
	StoredProductTagLink,
	StoredProductTagLink as StoredProductTagLinkType,
} from "../types.js";
import { computeBundleSummary, type BundleComputeSummary } from "../lib/catalog-bundles.js";
import { randomHex } from "../lib/crypto-adapter.js";
import { requirePost } from "../lib/require-post.js";
import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { sortedImmutable } from "../lib/sort-immutable.js";
import { throwCommerceApiError } from "../route-errors.js";
import type {
	ProductResponse,
	ProductSkuListResponse,
	ProductSkuResponse,
	StorefrontProductAvailability,
	StorefrontProductDetail,
	StorefrontProductListResponse,
	StorefrontSkuListResponse,
	ProductListResponse,
} from "./catalog.js";
import {
	queryBundleComponentsForProduct,
} from "./catalog-bundle.js";
import {
	queryAllPages,
	getManyByIds,
	hydrateSkusWithInventoryStock,
	loadProductReadMetadata,
	loadProductsReadMetadata,
	queryDigitalEntitlementSummariesBySkuIds,
	queryProductImagesByRoleForTargets,
	querySkuOptionValuesBySkuIds,
	summarizeInventory,
	summarizeSkuPricing,
	toUniqueStringList,
} from "./catalog-read-model.js";
import type { VariantMatrixDTO } from "../lib/catalog-dto.js";
import type { Collection } from "./catalog-conflict.js";
import {
	assertNoConflict,
	asCollection,
	asOptionalCollection,
	getNowIso,
	putWithConflictHandling,
	putWithUpdateConflictHandling,
} from "./catalog-conflict.js";

type ProductCategoryIdFilter = { categoryId: string };
type ProductTagIdFilter = { tagId: string };

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

type BundleDiscountPatchInput = {
	bundleDiscountType?: "none" | "fixed_amount" | "percentage";
	bundleDiscountValueMinor?: number;
	bundleDiscountValueBps?: number;
};

function assertBundleDiscountPatchForProduct(product: StoredProduct, patch: BundleDiscountPatchInput): void {
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

function toWhere(input: { type?: string; status?: string; visibility?: string }) {
	const where: Record<string, string> = {};
	if (input.type) where.type = input.type;
	if (input.status) where.status = input.status;
	if (input.visibility) where.visibility = input.visibility;
	return where;
}

function toStorefrontProductRecord(product: StoredProduct) {
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

function toStorefrontSkuSummary(sku: StoredProductSku) {
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

function toStorefrontVariantMatrixRow(row: VariantMatrixDTO) {
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

async function collectLinkedProductIds(links: Collection<{ productId: string }>, where: ProductCategoryIdFilter | ProductTagIdFilter): Promise<Set<string>> {
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

export async function handleCreateProduct(ctx: RouteContext<ProductCreateInput>): Promise<ProductResponse> {
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

export async function handleUpdateProduct(ctx: RouteContext<ProductUpdateInput>): Promise<ProductResponse> {
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

export async function handleSetProductState(ctx: RouteContext<ProductStateInput>): Promise<ProductResponse> {
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

export async function handleGetProduct(ctx: RouteContext<ProductGetInput>): Promise<ProductResponse> {
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
	const productTagLinks = asCollection<StoredProductTagLinkType>(ctx.storage.productTagLinks);
	const productDigitalAssets = asCollection<StoredDigitalAsset>(ctx.storage.digitalAssets);
	const productDigitalEntitlements = asCollection<StoredDigitalEntitlement>(ctx.storage.digitalEntitlements);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	const { skus: skuRows, categories, tags, primaryImage, galleryImages } = await loadProductReadMetadata({
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
		const skuOptionValuesBySku = await querySkuOptionValuesBySkuIds(productSkuOptionValues, skuRows.map((sku) => sku.id));
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
				const hydratedComponentSkus = await hydrateSkusWithInventoryStock(componentProduct, [componentSku], inventoryStock);
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

	const digitalEntitlements: ProductResponse["digitalEntitlements"] = [];
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

export async function handleListProducts(ctx: RouteContext<ProductListInput>): Promise<ProductListResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const productCategories = asCollection<StoredCategory>(ctx.storage.categories);
	const productCategoryLinks = asCollection<StoredProductCategoryLink>(ctx.storage.productCategoryLinks);
	const productTags = asCollection<StoredProductTag>(ctx.storage.productTags);
	const productTagLinks = asCollection<StoredProductTagLinkType>(ctx.storage.productTagLinks);
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
	const metadataByProduct = await loadProductsReadMetadata({
		productCategoryLinks,
		productCategories,
		productTagLinks,
		productTags,
		productAssets,
		productAssetLinks,
		productSkus,
		inventoryStock,
	}, {
		products: sortedRows,
		includeGalleryImages: true,
	});
	const items: ProductListResponse["items"] = [];
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

export async function handleCreateProductSku(ctx: RouteContext<ProductSkuCreateInput>): Promise<ProductSkuResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const productAttributes = asCollection<StoredProductAttribute>(ctx.storage.productAttributes);
	const productAttributeValues = asCollection<StoredProductAttributeValue>(ctx.storage.productAttributeValues);
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

export async function handleUpdateProductSku(ctx: RouteContext<ProductSkuUpdateInput>): Promise<ProductSkuResponse> {
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
	const shouldSyncInventoryStock = patch.inventoryQuantity !== undefined || patch.inventoryVersion !== undefined;
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

export async function handleSetSkuStatus(ctx: RouteContext<ProductSkuStateInput>): Promise<ProductSkuResponse> {
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

export async function handleListProductSkus(ctx: RouteContext<ProductSkuListInput>): Promise<ProductSkuListResponse> {
	requirePost(ctx);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);

	const result = await productSkus.query({
		where: { productId: ctx.input.productId },
		limit: ctx.input.limit,
	});
	const items = result.items.map((row) => row.data);

	return { items };
}

export async function handleGetStorefrontProduct(ctx: RouteContext<ProductGetInput>): Promise<StorefrontProductDetail> {
	const internal = await handleGetProduct(ctx);
	assertStorefrontProductVisible(internal.product);
	return toStorefrontProductDetail(internal);
}

export async function handleListStorefrontProducts(ctx: RouteContext<ProductListInput>): Promise<StorefrontProductListResponse> {
	const storefrontCtx = {
		...ctx,
		input: normalizeStorefrontProductListInput(ctx.input),
	} as RouteContext<ProductListInput>;
	const internal = await handleListProducts(storefrontCtx);
	return toStorefrontProductListResponse(internal);
}

export async function handleListStorefrontProductSkus(ctx: RouteContext<ProductSkuListInput>): Promise<StorefrontSkuListResponse> {
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	assertStorefrontProductVisible(product);
	const internal = await handleListProductSkus(ctx);
	return {
		items: internal.items.filter((sku) => sku.status === "active").map(toStorefrontSkuSummary),
	};
}
