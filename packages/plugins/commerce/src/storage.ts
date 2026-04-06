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

export const COMMERCE_STORAGE_CONFIG: PluginStorageConfig = {
	products: {
		indexes: ["type", "status", "visibility", "slug", "createdAt", "updatedAt", "featured"],
		uniqueIndexes: [["slug"]],
	},
	productAttributes: {
		indexes: [
			"productId",
			"kind",
			"code",
			"position",
			["productId", "kind"],
			["productId", "code"],
		],
		uniqueIndexes: [["productId", "code"]],
	},
	productAttributeValues: {
		indexes: [
			"attributeId",
			"code",
			"position",
			["attributeId", "code"],
		],
		uniqueIndexes: [["attributeId", "code"]],
	},
	productSkuOptionValues: {
		indexes: ["skuId", "attributeId", "attributeValueId"],
		uniqueIndexes: [["skuId", "attributeId"]],
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
		],
		uniqueIndexes: [["provider", "externalAssetId"]],
	},
	digitalEntitlements: {
		indexes: ["skuId", "digitalAssetId", "createdAt"],
		uniqueIndexes: [["skuId", "digitalAssetId"]],
	},
	categories: {
		indexes: ["slug", "name", "parentId", "position", ["parentId", "position"], ["parentId", "slug"]],
		uniqueIndexes: [["slug"]],
	},
	productCategoryLinks: {
		indexes: ["productId", "categoryId"],
		uniqueIndexes: [["productId", "categoryId"]],
	},
	productTags: {
		indexes: ["slug", "name", "createdAt"],
		uniqueIndexes: [["slug"]],
	},
	productTagLinks: {
		indexes: ["productId", "tagId"],
		uniqueIndexes: [["productId", "tagId"]],
	},
	bundleComponents: {
		indexes: [
			"bundleProductId",
			"componentSkuId",
			"position",
			"createdAt",
			["bundleProductId", "position"],
		],
		uniqueIndexes: [["bundleProductId", "componentSkuId"]],
	},
	productAssets: {
		indexes: [
			"provider",
			"externalAssetId",
			"createdAt",
			"updatedAt",
			["provider", "externalAssetId"],
		],
		uniqueIndexes: [["provider", "externalAssetId"]],
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
		],
		uniqueIndexes: [["targetType", "targetId", "assetId"]],
	},
	productSkus: {
		indexes: ["productId", "status", "requiresShipping", "createdAt", "skuCode"],
		uniqueIndexes: [["skuCode"]],
	},
	orders: {
		indexes: ["paymentPhase", "createdAt", "cartId"],
	},
	carts: {
		indexes: ["updatedAt"],
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
		],
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
		],
		uniqueIndexes: [["providerId", "externalEventId"]],
	},
	idempotencyKeys: {
		indexes: ["route", "createdAt", ["keyHash", "route"]],
		uniqueIndexes: [["keyHash", "route"]],
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
		],
		uniqueIndexes: [["referenceType", "referenceId", "productId", "variantId"]],
	},
	inventoryStock: {
		indexes: ["productId", "variantId", "updatedAt", ["productId", "variantId"]],
		uniqueIndexes: [["productId", "variantId"]],
	},
};
