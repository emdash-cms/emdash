/**
 * Declared plugin storage collections and indexes (EmDash `_plugin_storage`).
 */

import type { PluginStorageConfig } from "emdash";

export type CommerceStorage = PluginStorageConfig & {
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
		];
	};
	/** Materialized per SKU stock + monotonic version for finalize-time checks. */
	inventoryStock: {
		indexes: ["productId", "variantId", "updatedAt", ["productId", "variantId"]];
		uniqueIndexes: [["productId", "variantId"]];
	};
};

export const COMMERCE_STORAGE_CONFIG = {
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
		] as const,
	},
	inventoryStock: {
		indexes: ["productId", "variantId", "updatedAt", ["productId", "variantId"]] as const,
		uniqueIndexes: [["productId", "variantId"]] as const,
	},
} satisfies PluginStorageConfig;
