/**
 * Catalog management handlers for commerce plugin v1 foundation.
 *
 * This file implements the Phase 1 foundation slice from the catalog
 * specification: products and product SKUs with basic write/read paths and
 * invariant checks for catalog mutability and uniqueness constraints.
 */

import type { RouteContext } from "emdash";

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
} from "../lib/catalog-bundles.js";
import {
	handleLinkCatalogAsset,
	handleReorderCatalogAsset,
	handleRegisterProductAsset,
	handleUnlinkCatalogAsset,
} from "./catalog-asset.js";
import {
	handleAddBundleComponent,
	handleBundleCompute,
	handleRemoveBundleComponent,
	handleReorderBundleComponent,
} from "./catalog-bundle.js";
import {
	handleCreateDigitalAsset,
	handleCreateDigitalEntitlement,
	handleRemoveDigitalEntitlement,
} from "./catalog-digital.js";
import {
	handleCreateProduct,
	handleGetProduct,
	handleListProducts,
	handleSetProductState,
	handleUpdateProduct,
	handleCreateProductSku,
	handleUpdateProductSku,
	handleSetSkuStatus,
	handleListProductSkus,
	handleGetStorefrontProduct,
	handleListStorefrontProducts,
	handleListStorefrontProductSkus,
} from "./catalog-product.js";
import {
	handleCreateCategory,
	handleCreateTag,
	handleListCategories,
	handleCreateProductCategoryLink,
	handleCreateProductTagLink,
	handleRemoveProductCategoryLink,
	handleRemoveProductTagLink,
	handleListTags,
} from "./catalog-association.js";
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
	StoredProductSku,
} from "../types.js";
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


export async function createProductHandler(ctx: RouteContext<ProductCreateInput>): Promise<ProductResponse> {
	return handleCreateProduct(ctx);
}

export async function updateProductHandler(ctx: RouteContext<ProductUpdateInput>): Promise<ProductResponse> {
	return handleUpdateProduct(ctx);
}

export async function setProductStateHandler(ctx: RouteContext<ProductStateInput>): Promise<ProductResponse> {
	return handleSetProductState(ctx);
}

export async function getProductHandler(ctx: RouteContext<ProductGetInput>): Promise<ProductResponse> {
	return handleGetProduct(ctx);
}

export async function listProductsHandler(ctx: RouteContext<ProductListInput>): Promise<ProductListResponse> {
	return handleListProducts(ctx);
}

export async function createCategoryHandler(ctx: RouteContext<CategoryCreateInput>): Promise<CategoryResponse> {
	return handleCreateCategory(ctx);
}

export async function listCategoriesHandler(ctx: RouteContext<CategoryListInput>): Promise<CategoryListResponse> {
	return handleListCategories(ctx);
}

export async function createProductCategoryLinkHandler(
	ctx: RouteContext<ProductCategoryLinkInput>,
): Promise<ProductCategoryLinkResponse> {
	return handleCreateProductCategoryLink(ctx);
}

export async function removeProductCategoryLinkHandler(
	ctx: RouteContext<ProductCategoryUnlinkInput>,
): Promise<ProductCategoryLinkUnlinkResponse> {
	return handleRemoveProductCategoryLink(ctx);
}

export async function createTagHandler(ctx: RouteContext<TagCreateInput>): Promise<TagResponse> {
	return handleCreateTag(ctx);
}

export async function listTagsHandler(ctx: RouteContext<TagListInput>): Promise<TagListResponse> {
	return handleListTags(ctx);
}

export async function createProductTagLinkHandler(
	ctx: RouteContext<ProductTagLinkInput>,
): Promise<ProductTagLinkResponse> {
	return handleCreateProductTagLink(ctx);
}

export async function removeProductTagLinkHandler(
	ctx: RouteContext<ProductTagUnlinkInput>,
): Promise<ProductTagLinkUnlinkResponse> {
	return handleRemoveProductTagLink(ctx);
}

export async function createProductSkuHandler(
	ctx: RouteContext<ProductSkuCreateInput>,
): Promise<ProductSkuResponse> {
	return handleCreateProductSku(ctx);
}

export async function updateProductSkuHandler(
	ctx: RouteContext<ProductSkuUpdateInput>,
): Promise<ProductSkuResponse> {
	return handleUpdateProductSku(ctx);
}

export async function setSkuStatusHandler(
	ctx: RouteContext<ProductSkuStateInput>,
): Promise<ProductSkuResponse> {
	return handleSetSkuStatus(ctx);
}

export async function listProductSkusHandler(
	ctx: RouteContext<ProductSkuListInput>,
): Promise<ProductSkuListResponse> {
	return handleListProductSkus(ctx);
}

export async function getStorefrontProductHandler(
	ctx: RouteContext<ProductGetInput>,
): Promise<StorefrontProductDetail> {
	return handleGetStorefrontProduct(ctx);
}

export async function listStorefrontProductsHandler(
	ctx: RouteContext<ProductListInput>,
): Promise<StorefrontProductListResponse> {
	return handleListStorefrontProducts(ctx);
}

export async function listStorefrontProductSkusHandler(
	ctx: RouteContext<ProductSkuListInput>,
): Promise<StorefrontSkuListResponse> {
	return handleListStorefrontProductSkus(ctx);
}

export async function registerProductAssetHandler(
	ctx: RouteContext<ProductAssetRegisterInput>,
): Promise<ProductAssetResponse> {
	return handleRegisterProductAsset(ctx);
}

export async function linkCatalogAssetHandler(ctx: RouteContext<ProductAssetLinkInput>): Promise<ProductAssetLinkResponse> {
	return handleLinkCatalogAsset(ctx);
}

export async function unlinkCatalogAssetHandler(
	ctx: RouteContext<ProductAssetUnlinkInput>,
): Promise<ProductAssetUnlinkResponse> {
	return handleUnlinkCatalogAsset(ctx);
}

export async function reorderCatalogAssetHandler(
	ctx: RouteContext<ProductAssetReorderInput>,
): Promise<ProductAssetLinkResponse> {
	return handleReorderCatalogAsset(ctx);
}

export async function addBundleComponentHandler(
	ctx: RouteContext<BundleComponentAddInput>,
): Promise<BundleComponentResponse> {
	return handleAddBundleComponent(ctx);
}

export async function removeBundleComponentHandler(
	ctx: RouteContext<BundleComponentRemoveInput>,
): Promise<BundleComponentUnlinkResponse> {
	return handleRemoveBundleComponent(ctx);
}

export async function reorderBundleComponentHandler(
	ctx: RouteContext<BundleComponentReorderInput>,
): Promise<BundleComponentResponse> {
	return handleReorderBundleComponent(ctx);
}

export async function bundleComputeHandler(
	ctx: RouteContext<BundleComputeInput>,
): Promise<BundleComputeResponse> {
	return handleBundleCompute(ctx);
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
	return handleCreateDigitalAsset(ctx);
}

export async function createDigitalEntitlementHandler(
	ctx: RouteContext<DigitalEntitlementCreateInput>,
): Promise<DigitalEntitlementResponse> {
	return handleCreateDigitalEntitlement(ctx);
}

export async function removeDigitalEntitlementHandler(
	ctx: RouteContext<DigitalEntitlementRemoveInput>,
): Promise<DigitalEntitlementUnlinkResponse> {
	return handleRemoveDigitalEntitlement(ctx);
}
