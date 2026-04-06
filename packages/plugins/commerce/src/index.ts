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

import type { PluginDescriptor, PluginRoute, RouteContext } from "emdash";
import { definePlugin } from "emdash";

import {
	COMMERCE_EXTENSION_HOOKS,
	COMMERCE_KERNEL_RULES,
	COMMERCE_RECOMMENDATION_HOOKS,
	type CommerceRecommendationResolver,
} from "./catalog-extensibility.js";
import { cartGetHandler, cartUpsertHandler } from "./handlers/cart.js";
import {
	addBundleComponentHandler,
	removeBundleComponentHandler,
	reorderBundleComponentHandler,
	bundleComputeStorefrontHandler,
} from "./handlers/catalog-bundles.js";
import { createCategoryHandler, listCategoriesHandler, createProductCategoryLinkHandler, removeProductCategoryLinkHandler } from "./handlers/catalog-categories.js";
import {
	createDigitalAssetHandler,
	createDigitalEntitlementHandler,
	removeDigitalEntitlementHandler,
} from "./handlers/catalog-digital.js";
import {
	reorderCatalogAssetHandler,
	linkCatalogAssetHandler,
	registerProductAssetHandler,
	unlinkCatalogAssetHandler,
} from "./handlers/catalog-assets.js";
import {
	createProductHandler,
	updateProductHandler,
	setProductStateHandler,
	getStorefrontProductHandler,
	createProductSkuHandler,
	updateProductSkuHandler,
	setSkuStatusHandler,
	listStorefrontProductsHandler,
	listStorefrontProductSkusHandler,
} from "./handlers/catalog-products.js";
import { createTagHandler, listTagsHandler, createProductTagLinkHandler, removeProductTagLinkHandler } from "./handlers/catalog-tags.js";
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
	bundleComputeInputSchema,
	bundleComponentAddInputSchema,
	bundleComponentRemoveInputSchema,
	bundleComponentReorderInputSchema,
	categoryCreateInputSchema,
	categoryListInputSchema,
	digitalAssetCreateInputSchema,
	digitalEntitlementCreateInputSchema,
	digitalEntitlementRemoveInputSchema,
	productCategoryLinkInputSchema,
	productCategoryUnlinkInputSchema,
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
	tagCreateInputSchema,
	tagListInputSchema,
	productTagLinkInputSchema,
	productTagUnlinkInputSchema,
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

/**
 * Route helper constructors to keep public/private registration explicit and avoid
 * accidental exposure of mutation endpoints.
 */
function adminRoute<T>(input: PluginRoute<T>["input"], handler: AnyHandler): PluginRoute<T> {
	return {
		input,
		handler: asRouteHandler(handler),
	};
}

function publicRoute<T>(input: PluginRoute<T>["input"], handler: AnyHandler): PluginRoute<T> {
	return {
		public: true,
		input,
		handler: asRouteHandler(handler),
	};
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
			// Storefront-safe read and action routes (public API surface).
			"cart/upsert": publicRoute(cartUpsertInputSchema, cartUpsertHandler),
			"cart/get": publicRoute(cartGetInputSchema, cartGetHandler),
			"bundle/compute": publicRoute(bundleComputeInputSchema, bundleComputeStorefrontHandler),
			"catalog/product/get": publicRoute(productGetInputSchema, getStorefrontProductHandler),
			"catalog/category/list": publicRoute(categoryListInputSchema, listCategoriesHandler),
			"catalog/tag/list": publicRoute(tagListInputSchema, listTagsHandler),
			"catalog/products": publicRoute(productListInputSchema, listStorefrontProductsHandler),
			"catalog/sku/list": publicRoute(productSkuListInputSchema, listStorefrontProductSkusHandler),
			checkout: publicRoute(checkoutInputSchema, checkoutHandler),
			"checkout/get-order": publicRoute(checkoutGetOrderInputSchema, checkoutGetOrderHandler),
			recommendations: publicRoute(recommendationsInputSchema, recommendationsRouteHandler),
			"webhooks/stripe": publicRoute(stripeWebhookInputSchema, stripeWebhookHandler),

			// Admin/auth-required catalog and commerce-admin mutation routes.
			"product-assets/register": adminRoute(productAssetRegisterInputSchema, registerProductAssetHandler),
			"catalog/asset/link": adminRoute(productAssetLinkInputSchema, linkCatalogAssetHandler),
			"catalog/asset/unlink": adminRoute(productAssetUnlinkInputSchema, unlinkCatalogAssetHandler),
			"catalog/asset/reorder": adminRoute(productAssetReorderInputSchema, reorderCatalogAssetHandler),
			"bundle-components/add": adminRoute(bundleComponentAddInputSchema, addBundleComponentHandler),
			"bundle-components/remove": adminRoute(
				bundleComponentRemoveInputSchema,
				removeBundleComponentHandler,
			),
			"bundle-components/reorder": adminRoute(
				bundleComponentReorderInputSchema,
				reorderBundleComponentHandler,
			),
			"digital-assets/create": adminRoute(digitalAssetCreateInputSchema, createDigitalAssetHandler),
			"digital-entitlements/create": adminRoute(
				digitalEntitlementCreateInputSchema,
				createDigitalEntitlementHandler,
			),
			"digital-entitlements/remove": adminRoute(
				digitalEntitlementRemoveInputSchema,
				removeDigitalEntitlementHandler,
			),
			"catalog/product/create": adminRoute(productCreateInputSchema, createProductHandler),
			"catalog/product/update": adminRoute(productUpdateInputSchema, updateProductHandler),
			"catalog/product/state": adminRoute(productStateInputSchema, setProductStateHandler),
			"catalog/category/create": adminRoute(categoryCreateInputSchema, createCategoryHandler),
			"catalog/category/link": adminRoute(productCategoryLinkInputSchema, createProductCategoryLinkHandler),
			"catalog/category/unlink": adminRoute(productCategoryUnlinkInputSchema, removeProductCategoryLinkHandler),
			"catalog/tag/create": adminRoute(tagCreateInputSchema, createTagHandler),
			"catalog/tag/link": adminRoute(productTagLinkInputSchema, createProductTagLinkHandler),
			"catalog/tag/unlink": adminRoute(productTagUnlinkInputSchema, removeProductTagLinkHandler),
			"catalog/sku/create": adminRoute(productSkuCreateInputSchema, createProductSkuHandler),
			"catalog/sku/update": adminRoute(productSkuUpdateInputSchema, updateProductSkuHandler),
			"catalog/sku/state": adminRoute(productSkuStateInputSchema, setSkuStatusHandler),
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
	ProductResponse,
	ProductListResponse,
	ProductSkuResponse,
	ProductSkuListResponse,
	StorefrontProductDetail,
	StorefrontProductListResponse,
	StorefrontSkuListResponse,
} from "./handlers/catalog-products.js";
export type {
	CategoryResponse,
	CategoryListResponse,
	ProductCategoryLinkResponse,
	ProductCategoryLinkUnlinkResponse,
} from "./handlers/catalog-categories.js";
export type {
	TagResponse,
	TagListResponse,
	ProductTagLinkResponse,
	ProductTagLinkUnlinkResponse,
} from "./handlers/catalog-tags.js";
export type {
	ProductAssetResponse,
	ProductAssetLinkResponse,
	ProductAssetUnlinkResponse,
} from "./handlers/catalog-assets.js";
export type {
	BundleComponentResponse,
	BundleComponentUnlinkResponse,
	BundleComputeResponse,
	StorefrontBundleComputeResponse,
} from "./handlers/catalog-bundles.js";
export type {
	DigitalAssetResponse,
	DigitalEntitlementResponse,
	DigitalEntitlementUnlinkResponse,
} from "./handlers/catalog-digital.js";
