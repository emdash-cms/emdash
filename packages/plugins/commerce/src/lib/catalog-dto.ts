import type {
	StoredCategory,
	StoredProduct,
	StoredProductAttribute,
	StoredProductSku,
	StoredProductTag,
} from "../types.js";
import type { BundleComputeSummary } from "./catalog-bundles.js";

export type BundleSummaryDTO = BundleComputeSummary;

export type ProductCategoryDTO = Pick<
	StoredCategory,
	"id" | "name" | "slug" | "parentId" | "position"
>;

export type ProductTagDTO = Pick<StoredProductTag, "id" | "name" | "slug">;

export interface ProductDigitalEntitlementSummary {
	skuId: string;
	entitlements: Array<{
		entitlementId: string;
		digitalAssetId: string;
		digitalAssetLabel?: string;
		grantedQuantity: number;
		downloadLimit?: number;
		downloadExpiryDays?: number;
		isManualOnly: boolean;
		isPrivate: boolean;
	}>;
}

export type VariantMatrixDTO = {
	skuId: string;
	skuCode: string;
	status: StoredProductSku["status"];
	unitPriceMinor: number;
	compareAtPriceMinor?: number;
	inventoryQuantity: number;
	inventoryVersion: number;
	requiresShipping: boolean;
	isDigital: boolean;
	image?: ProductPrimaryImageDTO;
	options: Array<{
		attributeId: string;
		attributeValueId: string;
	}>;
};

export interface ProductInventorySummaryDTO {
	/** Number of SKUs attached to the product. */
	skuCount: number;
	/** Number of SKUs currently active. */
	activeSkuCount: number;
	/** Sum of inventory across all SKUs. */
	totalInventoryQuantity: number;
}

export interface ProductPriceRangeDTO {
	minUnitPriceMinor?: number;
	maxUnitPriceMinor?: number;
}

export interface ProductPrimaryImageDTO {
	linkId: string;
	assetId: string;
	provider: string;
	externalAssetId: string;
	fileName?: string;
	altText?: string;
}

export interface ProductDetailDTO {
	product: StoredProduct;
	skus: StoredProductSku[];
	attributes?: StoredProductAttribute[];
	variantMatrix?: VariantMatrixDTO[];
	categories: ProductCategoryDTO[];
	tags: ProductTagDTO[];
	digitalEntitlements?: ProductDigitalEntitlementSummary[];
	bundleSummary?: BundleSummaryDTO;
	primaryImage?: ProductPrimaryImageDTO;
	galleryImages?: ProductPrimaryImageDTO[];
}

export interface CatalogListingDTO {
	product: StoredProduct;
	priceRange: ProductPriceRangeDTO;
	inventorySummary: ProductInventorySummaryDTO;
	primaryImage?: ProductPrimaryImageDTO;
	galleryImages?: ProductPrimaryImageDTO[];
	lowStockSkuCount?: number;
	categories: ProductCategoryDTO[];
	tags: ProductTagDTO[];
}

export type ProductAdminDTO = CatalogListingDTO & {
	/** Explicitly include low-cardinality state for admin surfaces. */
	lowStockSkuCount: number;
};
