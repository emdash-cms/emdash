/**
 * EmDash commerce plugin — kernel-first checkout + webhook finalize (Stripe wiring follows).
 *
 * @example
 * ```ts
 * // live.config.ts
 * import { commercePlugin } from "@emdash-cms/plugin-commerce";
 * export default defineConfig({ plugins: [commercePlugin()] });
 * ```
 */

import type { PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

import { checkoutHandler } from "./handlers/checkout.js";
import { stripeWebhookHandler } from "./handlers/webhooks-stripe.js";
import { checkoutInputSchema, stripeWebhookInputSchema } from "./schemas.js";
import { COMMERCE_STORAGE_CONFIG } from "./storage.js";

export function commercePlugin(): PluginDescriptor {
	return {
		id: "emdash-commerce",
		version: "0.1.0",
		entrypoint: "@emdash-cms/plugin-commerce",
		storage: {
			orders: { indexes: ["paymentPhase", "createdAt", "cartId"] },
			carts: { indexes: ["updatedAt"] },
			paymentAttempts: {
				indexes: ["orderId", "providerId", "status", "createdAt"],
			},
			webhookReceipts: {
				indexes: ["providerId", "externalEventId", "orderId", "status", "createdAt"],
			},
			idempotencyKeys: {
				indexes: ["route", "createdAt", "keyHash"],
			},
			inventoryLedger: {
				indexes: ["productId", "variantId", "referenceType", "referenceId", "createdAt"],
			},
			inventoryStock: {
				indexes: ["productId", "variantId", "updatedAt"],
			},
		},
	};
}

export function createPlugin() {
	return definePlugin({
		id: "emdash-commerce",
		version: "0.1.0",
		storage: COMMERCE_STORAGE_CONFIG,
		routes: {
			checkout: {
				public: true,
				input: checkoutInputSchema,
				handler: checkoutHandler as never,
			},
			"webhooks/stripe": {
				public: true,
				input: stripeWebhookInputSchema,
				handler: stripeWebhookHandler as never,
			},
		},
	});
}

export default createPlugin;

export type * from "./types.js";
export type { CommerceStorage } from "./storage.js";
export { COMMERCE_STORAGE_CONFIG } from "./storage.js";
export {
	finalizePaymentFromWebhook,
	webhookReceiptDocId,
	receiptToView,
	inventoryStockDocId,
} from "./orchestration/finalize-payment.js";
export { throwCommerceApiError } from "./route-errors.js";
