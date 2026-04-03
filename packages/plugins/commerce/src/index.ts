/**
 * EmDash commerce plugin — kernel-first checkout + webhook finalize (Stripe wiring follows).
 *
 * Batch writes: checkout uses `putMany` per collection where two documents are created
 * together; cron cleanup uses `deleteMany` for idempotency TTL. Finalize keeps interleaved
 * ledger + stock `put`s per SKU to avoid inconsistent partial batches.
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

import { handleIdempotencyCleanup } from "./handlers/cron.js";
import { checkoutGetOrderHandler } from "./handlers/checkout-get-order.js";
import { checkoutHandler } from "./handlers/checkout.js";
import { recommendationsHandler } from "./handlers/recommendations.js";
import { stripeWebhookHandler } from "./handlers/webhooks-stripe.js";
import {
	checkoutGetOrderInputSchema,
	checkoutInputSchema,
	recommendationsInputSchema,
	stripeWebhookInputSchema,
} from "./schemas.js";
import { COMMERCE_STORAGE_CONFIG } from "./storage.js";

/** Outbound Stripe API (`api.stripe.com`, `connect.stripe.com`, etc.). */
const STRIPE_ALLOWED_HOSTS = ["*.stripe.com"] as const;

export function commercePlugin(): PluginDescriptor {
	return {
		id: "emdash-commerce",
		version: "0.1.0",
		entrypoint: "@emdash-cms/plugin-commerce",
		capabilities: ["network:fetch"],
		allowedHosts: [...STRIPE_ALLOWED_HOSTS],
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
		capabilities: ["network:fetch"],
		allowedHosts: [...STRIPE_ALLOWED_HOSTS],

		storage: COMMERCE_STORAGE_CONFIG,

		admin: {
			settingsSchema: {
				stripePublishableKey: {
					type: "string",
					label: "Stripe publishable key",
					description: "Used by the storefront / Elements (pk_…).",
					default: "",
				},
				stripeSecretKey: {
					type: "secret",
					label: "Stripe secret key",
					description: "Server-side API key (sk_…). Required for PaymentIntents and refunds.",
				},
				stripeWebhookSecret: {
					type: "secret",
					label: "Stripe webhook signing secret",
					description: "whsec_… from the Stripe Dashboard; used to verify webhook signatures.",
				},
				defaultCurrency: {
					type: "string",
					label: "Default currency (ISO 4217)",
					description: "Fallback when cart currency is absent (e.g. USD).",
					default: "USD",
				},
			},
		},

		hooks: {
			"plugin:activate": {
				handler: async (_event, ctx) => {
					if (ctx.cron) {
						await ctx.cron.schedule("idempotency-cleanup", { schedule: "@weekly" });
					}
				},
			},
			cron: {
				handler: async (event, ctx) => {
					if (event.name === "idempotency-cleanup") {
						await handleIdempotencyCleanup(ctx);
					}
				},
			},
		},

		routes: {
			checkout: {
				public: true,
				input: checkoutInputSchema,
				handler: checkoutHandler as never,
			},
			"checkout/get-order": {
				public: true,
				input: checkoutGetOrderInputSchema,
				handler: checkoutGetOrderHandler as never,
			},
			recommendations: {
				public: true,
				input: recommendationsInputSchema,
				handler: recommendationsHandler as never,
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
export { COMMERCE_SETTINGS_KEYS } from "./settings-keys.js";
export {
	finalizePaymentFromWebhook,
	webhookReceiptDocId,
	receiptToView,
	inventoryStockDocId,
} from "./orchestration/finalize-payment.js";
export { throwCommerceApiError } from "./route-errors.js";
export type {
	CommerceCatalogProductSearchFields,
} from "./catalog-extensibility.js";
export { COMMERCE_EXTENSION_HOOKS } from "./catalog-extensibility.js";
export type { RecommendationsResponse } from "./handlers/recommendations.js";
export type { CheckoutGetOrderResponse } from "./handlers/checkout-get-order.js";
