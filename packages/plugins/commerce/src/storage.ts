/**
 * Declared plugin storage collections and indexes (EmDash `_plugin_storage`).
 */

import type { PluginStorageConfig } from "emdash";

export type CommerceStorage = PluginStorageConfig & {
	products: {
		indexes: ["type", "status", "visibility", "slug", "createdAt", "updatedAt", "featured"];
		uniqueIndexes: [["slug"]];
	};
	productAttributes: {
		indexes: ["productId", "kind", "code", "position", ["productId", "kind"], ["productId", "code"]];
		uniqueIndexes: [["productId", "code"]];
	};
	productAttributeValues: {
		indexes: ["attributeId", "code", "position", ["attributeId", "code"]];
		uniqueIndexes: [["attributeId", "code"]];
	};
	productSkuOptionValues: {
		indexes: ["skuId", "attributeId", "attributeValueId"];
		uniqueIndexes: [["skuId", "attributeId"]];
	};
	digitalAssets: {
		indexes: ["provider", "externalAssetId", "label", "isPrivate", "isManualOnly", "createdAt", ["provider", "externalAssetId"]];
		uniqueIndexes: [["provider", "externalAssetId"]];
	};
	digitalEntitlements: {
		indexes: ["skuId", "digitalAssetId", "createdAt"];
		uniqueIndexes: [["skuId", "digitalAssetId"]];
	};
	categories: {
		indexes: ["slug", "name", "parentId", "position", ["parentId", "position"], ["parentId", "slug"]];
		uniqueIndexes: [["slug"]];
	};
	productCategoryLinks: {
		indexes: ["productId", "categoryId"];
		uniqueIndexes: [["productId", "categoryId"]];
	};
	productTags: {
		indexes: ["slug", "name", "createdAt"];
		uniqueIndexes: [["slug"]];
	};
	productTagLinks: {
		indexes: ["productId", "tagId"];
		uniqueIndexes: [["productId", "tagId"]];
	};
	bundleComponents: {
		indexes: ["bundleProductId", "componentSkuId", "position", "createdAt", ["bundleProductId", "position"]];
		uniqueIndexes: [["bundleProductId", "componentSkuId"]];
	};
	productAssets: {
		indexes: ["provider", "externalAssetId", "createdAt", "updatedAt", ["provider", "externalAssetId"]];
		uniqueIndexes: [["provider", "externalAssetId"]];
	};
	productAssetLinks: {
		indexes: [
			"targetType",
			"targetId",
			"role",
			"position",
			"createdAt",
			"assetId",
			["targetType", "targetId"],
		];
		uniqueIndexes: [["targetType", "targetId", "assetId"]];
	};
	productSkus: {
		indexes: ["productId", "status", "requiresShipping", "createdAt", "skuCode"];
		uniqueIndexes: [["skuCode"]];
	};
	orders: {
		indexes: ["paymentPhase", "createdAt", "cartId"];
	};
	carts: {
		indexes: ["updatedAt"];
	};
	paymentAttempts: {
		indexes: [
			"orderId",
			"providerId",
			"status",
			"createdAt",
			["orderId", "status"],
			["orderId", "providerId", "status"],
			["providerId", "createdAt"],
		];
	};
	webhookReceipts: {
		indexes: [
			"providerId",
			"externalEventId",
			"orderId",
			"status",
			"createdAt",
			["providerId", "externalEventId"],
			["orderId", "createdAt"],
		];
		uniqueIndexes: [["providerId", "externalEventId"]];
	};
	idempotencyKeys: {
		indexes: ["route", "createdAt", ["keyHash", "route"]];
		uniqueIndexes: [["keyHash", "route"]];
	};
	inventoryLedger: {
		indexes: [
			"productId",
			"variantId",
			"referenceType",
			"referenceId",
			"createdAt",
			["productId", "createdAt"],
			["variantId", "createdAt"],
			["referenceType", "referenceId"],
		];
		uniqueIndexes: [["referenceType", "referenceId", "productId", "variantId"]];
	};
	/** Materialized per SKU stock + monotonic version for finalize-time checks. */
	inventoryStock: {
		indexes: ["productId", "variantId", "updatedAt", ["productId", "variantId"]];
		uniqueIndexes: [["productId", "variantId"]];
	};
};

export const COMMERCE_STORAGE_CONFIG = {
	products: {
		indexes: ["type", "status", "visibility", "slug", "createdAt", "updatedAt", "featured"] as const,
		uniqueIndexes: [["slug"]] as const,
	},
	productAttributes: {
		indexes: [
			"productId",
			"kind",
			"code",
			"position",
			["productId", "kind"],
			["productId", "code"],
		] as const,
		uniqueIndexes: [["productId", "code"]] as const,
	},
	productAttributeValues: {
		indexes: [
			"attributeId",
			"code",
			"position",
			["attributeId", "code"],
		] as const,
		uniqueIndexes: [["attributeId", "code"]] as const,
	},
	productSkuOptionValues: {
		indexes: ["skuId", "attributeId", "attributeValueId"] as const,
		uniqueIndexes: [["skuId", "attributeId"]] as const,
	},
	digitalAssets: {
		indexes: [
			"provider",
			"externalAssetId",
			"label",
			"isPrivate",
			"isManualOnly",
			"createdAt",
			["provider", "externalAssetId"],
		] as const,
		uniqueIndexes: [["provider", "externalAssetId"]] as const,
	},
	digitalEntitlements: {
		indexes: ["skuId", "digitalAssetId", "createdAt"] as const,
		uniqueIndexes: [["skuId", "digitalAssetId"]] as const,
	},
	categories: {
		indexes: ["slug", "name", "parentId", "position", ["parentId", "position"], ["parentId", "slug"]] as const,
		uniqueIndexes: [["slug"]] as const,
	},
	productCategoryLinks: {
		indexes: ["productId", "categoryId"] as const,
		uniqueIndexes: [["productId", "categoryId"]] as const,
	},
	productTags: {
		indexes: ["slug", "name", "createdAt"] as const,
		uniqueIndexes: [["slug"]] as const,
	},
	productTagLinks: {
		indexes: ["productId", "tagId"] as const,
		uniqueIndexes: [["productId", "tagId"]] as const,
	},
	bundleComponents: {
		indexes: [
			"bundleProductId",
			"componentSkuId",
			"position",
			"createdAt",
			["bundleProductId", "position"],
		] as const,
		uniqueIndexes: [["bundleProductId", "componentSkuId"]] as const,
	},
	productAssets: {
		indexes: [
			"provider",
			"externalAssetId",
			"createdAt",
			"updatedAt",
			["provider", "externalAssetId"],
		] as const,
		uniqueIndexes: [["provider", "externalAssetId"]] as const,
	},
	productAssetLinks: {
		indexes: [
			"targetType",
			"targetId",
			"role",
			"position",
			"createdAt",
			"assetId",
			["targetType", "targetId"],
		] as const,
		uniqueIndexes: [["targetType", "targetId", "assetId"]] as const,
	},
	productSkus: {
		indexes: ["productId", "status", "requiresShipping", "createdAt", "skuCode"] as const,
		uniqueIndexes: [["skuCode"]] as const,
	},
	orders: {
		indexes: ["paymentPhase", "createdAt", "cartId"] as const,
	},
	carts: {
		indexes: ["updatedAt"] as const,
	},
	paymentAttempts: {
		indexes: [
			"orderId",
			"providerId",
			"status",
			"createdAt",
			["orderId", "status"],
			["orderId", "providerId", "status"],
			["providerId", "createdAt"],
		] as const,
	},
	webhookReceipts: {
		indexes: [
			"providerId",
			"externalEventId",
			"orderId",
			"status",
			"createdAt",
			["providerId", "externalEventId"],
			["orderId", "createdAt"],
		] as const,
		uniqueIndexes: [["providerId", "externalEventId"]] as const,
	},
	idempotencyKeys: {
		indexes: ["route", "createdAt", ["keyHash", "route"]] as const,
		uniqueIndexes: [["keyHash", "route"]] as const,
	},
	inventoryLedger: {
		indexes: [
			"productId",
			"variantId",
			"referenceType",
			"referenceId",
			"createdAt",
			["productId", "createdAt"],
			["variantId", "createdAt"],
			["referenceType", "referenceId"],
		] as const,
		uniqueIndexes: [["referenceType", "referenceId", "productId", "variantId"]] as const,
	},
	inventoryStock: {
		indexes: ["productId", "variantId", "updatedAt", ["productId", "variantId"]] as const,
		uniqueIndexes: [["productId", "variantId"]] as const,
	},
} satisfies PluginStorageConfig;
