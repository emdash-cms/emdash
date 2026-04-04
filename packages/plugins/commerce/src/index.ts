/**
 * EmDash commerce plugin — kernel-first checkout + webhook finalize (Stripe wiring follows).
 *
 * Persistence: checkout writes the order and payment attempt as separate `put` calls;
 * cron cleanup uses `deleteMany` on idempotency keys. Finalize uses interleaved
 * ledger + stock `put`s per SKU to avoid inconsistent partial batches.
 *
 * @example
 * ```ts
 * // live.config.ts
 * import { createPlugin } from "@emdash-cms/plugin-commerce";
 * export default defineConfig({ plugins: [createPlugin()] });
 * ```
 */

import type { PluginDescriptor, RouteContext } from "emdash";
import { definePlugin } from "emdash";

import {
	COMMERCE_EXTENSION_HOOKS,
	COMMERCE_KERNEL_RULES,
	COMMERCE_RECOMMENDATION_HOOKS,
	type CommerceRecommendationResolver,
} from "./catalog-extensibility.js";
import { cartGetHandler, cartUpsertHandler } from "./handlers/cart.js";
import {
	linkCatalogAssetHandler,
	createDigitalAssetHandler,
	createDigitalEntitlementHandler,
	removeDigitalEntitlementHandler,
	reorderCatalogAssetHandler,
	registerProductAssetHandler,
	unlinkCatalogAssetHandler,
	setProductStateHandler,
	createProductHandler,
	createProductSkuHandler,
	getProductHandler,
	setSkuStatusHandler,
	updateProductHandler,
	updateProductSkuHandler,
	listProductSkusHandler,
	listProductsHandler,
} from "./handlers/catalog.js";
import { checkoutGetOrderHandler } from "./handlers/checkout-get-order.js";
import { checkoutHandler } from "./handlers/checkout.js";
import { handleIdempotencyCleanup } from "./handlers/cron.js";
import { stripeWebhookHandler } from "./handlers/webhooks-stripe.js";
import {
	cartGetInputSchema,
	cartUpsertInputSchema,
	productAssetLinkInputSchema,
	productAssetReorderInputSchema,
	productAssetRegisterInputSchema,
	productAssetUnlinkInputSchema,
	digitalAssetCreateInputSchema,
	digitalEntitlementCreateInputSchema,
	digitalEntitlementRemoveInputSchema,
	productCreateInputSchema,
	productGetInputSchema,
	productSkuStateInputSchema,
	productListInputSchema,
	productSkuCreateInputSchema,
	productSkuUpdateInputSchema,
	productSkuListInputSchema,
	productStateInputSchema,
	productUpdateInputSchema,
	checkoutGetOrderInputSchema,
	checkoutInputSchema,
	recommendationsInputSchema,
	stripeWebhookInputSchema,
} from "./schemas.js";
import { createRecommendationsRoute } from "./services/commerce-extension-seams.js";
import { COMMERCE_STORAGE_CONFIG } from "./storage.js";

/**
 * The EmDash `definePlugin` route handler type requires handlers typed against
 * the specific plugin's storage shape, which TypeScript cannot infer from the
 * generic `PluginDescriptor`. All casts are isolated here so they do not
 * spread into handler files.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (ctx: RouteContext<any>) => Promise<unknown>;

function asRouteHandler(fn: AnyHandler): never {
	return fn as never;
}

/** Outbound Stripe API (`api.stripe.com`, `connect.stripe.com`, etc.). */
const STRIPE_ALLOWED_HOSTS = ["*.stripe.com"] as const;

/**
 * Manifest-style descriptor; uses the same storage declaration as {@link createPlugin}.
 * Cast matches `PluginDescriptor`’s simplified typing; composite indexes match runtime config.
 */
export function commercePlugin(): PluginDescriptor {
	return {
		id: "emdash-commerce",
		version: "0.1.0",
		entrypoint: "@emdash-cms/plugin-commerce",
		capabilities: ["network:fetch"],
		allowedHosts: [...STRIPE_ALLOWED_HOSTS],
		storage: COMMERCE_STORAGE_CONFIG as unknown as PluginDescriptor["storage"],
	};
}

export interface CommercePluginOptions {
	extensions?: {
		/**
		 * Optional read-only recommendation provider adapter for storefront features.
		 * The provider must only return product IDs and must not mutate commerce data.
		 */
		recommendationResolver?: CommerceRecommendationResolver;
		/**
		 * Optional provider identifier for diagnostic/correlation output from recommender.
		 */
		recommendationProviderId?: string;
	};
}

export function createPlugin(options: CommercePluginOptions = {}) {
	const recommendationsRouteHandler = createRecommendationsRoute({
		resolver: options.extensions?.recommendationResolver,
		providerId: options.extensions?.recommendationProviderId,
	});
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
			"cart/upsert": {
				public: true,
				input: cartUpsertInputSchema,
				handler: asRouteHandler(cartUpsertHandler),
			},
			"cart/get": {
				public: true,
				input: cartGetInputSchema,
				handler: asRouteHandler(cartGetHandler),
			},
			"product-assets/register": {
				public: true,
				input: productAssetRegisterInputSchema,
				handler: asRouteHandler(registerProductAssetHandler),
			},
			"catalog/asset/link": {
				public: true,
				input: productAssetLinkInputSchema,
				handler: asRouteHandler(linkCatalogAssetHandler),
			},
			"catalog/asset/unlink": {
				public: true,
				input: productAssetUnlinkInputSchema,
				handler: asRouteHandler(unlinkCatalogAssetHandler),
			},
			"catalog/asset/reorder": {
				public: true,
				input: productAssetReorderInputSchema,
				handler: asRouteHandler(reorderCatalogAssetHandler),
			},
			"digital-assets/create": {
				public: true,
				input: digitalAssetCreateInputSchema,
				handler: asRouteHandler(createDigitalAssetHandler),
			},
			"digital-entitlements/create": {
				public: true,
				input: digitalEntitlementCreateInputSchema,
				handler: asRouteHandler(createDigitalEntitlementHandler),
			},
			"digital-entitlements/remove": {
				public: true,
				input: digitalEntitlementRemoveInputSchema,
				handler: asRouteHandler(removeDigitalEntitlementHandler),
			},
			"catalog/product/create": {
				public: true,
				input: productCreateInputSchema,
				handler: asRouteHandler(createProductHandler),
			},
			"catalog/product/get": {
				public: true,
				input: productGetInputSchema,
				handler: asRouteHandler(getProductHandler),
			},
			"catalog/product/update": {
				public: true,
				input: productUpdateInputSchema,
				handler: asRouteHandler(updateProductHandler),
			},
			"catalog/product/state": {
				public: true,
				input: productStateInputSchema,
				handler: asRouteHandler(setProductStateHandler),
			},
			"catalog/products": {
				public: true,
				input: productListInputSchema,
				handler: asRouteHandler(listProductsHandler),
			},
			"catalog/sku/create": {
				public: true,
				input: productSkuCreateInputSchema,
				handler: asRouteHandler(createProductSkuHandler),
			},
			"catalog/sku/update": {
				public: true,
				input: productSkuUpdateInputSchema,
				handler: asRouteHandler(updateProductSkuHandler),
			},
			"catalog/sku/state": {
				public: true,
				input: productSkuStateInputSchema,
				handler: asRouteHandler(setSkuStatusHandler),
			},
			"catalog/sku/list": {
				public: true,
				input: productSkuListInputSchema,
				handler: asRouteHandler(listProductSkusHandler),
			},
			checkout: {
				public: true,
				input: checkoutInputSchema,
				handler: asRouteHandler(checkoutHandler),
			},
			"checkout/get-order": {
				public: true,
				input: checkoutGetOrderInputSchema,
				handler: asRouteHandler(checkoutGetOrderHandler),
			},
			recommendations: {
				public: true,
				input: recommendationsInputSchema,
				handler: asRouteHandler(recommendationsRouteHandler),
			},
			"webhooks/stripe": {
				public: true,
				input: stripeWebhookInputSchema,
				handler: asRouteHandler(stripeWebhookHandler),
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
	COMMERCE_EXTENSION_HOOKS,
	COMMERCE_RECOMMENDATION_HOOKS,
	COMMERCE_KERNEL_RULES,
} from "./catalog-extensibility.js";
export {
	finalizePaymentFromWebhook,
	webhookReceiptDocId,
	receiptToView,
	inventoryStockDocId,
} from "./orchestration/finalize-payment.js";
export { throwCommerceApiError } from "./route-errors.js";
export type { CommerceCatalogProductSearchFields } from "./catalog-extensibility.js";
export {
	createRecommendationsRoute,
	createPaymentWebhookRoute,
	queryFinalizationState,
	COMMERCE_MCP_ACTORS,
	type CommerceMcpActor,
	type CommerceMcpOperationContext,
} from "./services/commerce-extension-seams.js";
export { PAYMENT_DEFAULTS } from "./services/commerce-provider-contracts.js";
export type {
	CommerceProviderDescriptor,
	CommerceProviderType,
	CommerceWebhookInput,
	CommerceWebhookFinalizeResponse,
} from "./services/commerce-provider-contracts.js";
export type { RecommendationsHandlerOptions } from "./handlers/recommendations.js";
export type {
	CommerceWebhookAdapter,
	WebhookFinalizeResponse,
} from "./handlers/webhook-handler.js";
export type { RecommendationsResponse } from "./handlers/recommendations.js";
export type { CheckoutGetOrderResponse } from "./handlers/checkout-get-order.js";
export type { CartUpsertResponse, CartGetResponse } from "./handlers/cart.js";
export type {
	ProductAssetLinkResponse,
	ProductAssetResponse,
	ProductAssetUnlinkResponse,
	DigitalAssetResponse,
	DigitalEntitlementResponse,
	DigitalEntitlementUnlinkResponse,
	ProductResponse,
	ProductListResponse,
	ProductSkuResponse,
	ProductSkuListResponse,
} from "./handlers/catalog.js";
