/**
 * Zod input validation for commerce plugin routes.
 */

import { z } from "astro/zod";

import { COMMERCE_LIMITS } from "./kernel/limits.js";

const bounded = (max: number) => z.string().min(1).max(max);
type BundleDiscountType = "none" | "fixed_amount" | "percentage";
type BundleDiscountInput = {
	bundleDiscountType?: BundleDiscountType;
	bundleDiscountValueMinor?: number;
	bundleDiscountValueBps?: number;
};

function addBundleDiscountIssue(ctx: z.RefinementCtx, message: string, path: string[]): void {
	ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message,
		path,
	});
}

function validateBundleDiscountForProductType(
	ctx: z.RefinementCtx,
	productType: "simple" | "variable" | "bundle",
	input: BundleDiscountInput,
): void {
	const hasDiscountType = input.bundleDiscountType !== undefined;
	const hasFixedAmountValue = input.bundleDiscountValueMinor !== undefined;
	const hasBpsValue = input.bundleDiscountValueBps !== undefined;
	const discountType: BundleDiscountType = input.bundleDiscountType ?? "none";

	if (productType !== "bundle") {
		if (hasDiscountType || hasFixedAmountValue || hasBpsValue) {
			addBundleDiscountIssue(ctx, "Bundle discount fields are only supported for bundle products", [
				"bundleDiscountType",
			]);
		}
		return;
	}

	if (discountType === "fixed_amount" && hasBpsValue) {
		addBundleDiscountIssue(ctx, "bundleDiscountValueBps can only be used with percentage bundles", [
			"bundleDiscountValueBps",
		]);
		return;
	}

	if (discountType === "percentage" && hasFixedAmountValue) {
		addBundleDiscountIssue(
			ctx,
			"bundleDiscountValueMinor can only be used with fixed-amount bundles",
			["bundleDiscountValueMinor"],
		);
		return;
	}

	if (discountType === "none" && (hasFixedAmountValue || hasBpsValue)) {
		addBundleDiscountIssue(ctx, "Bundle discount values cannot be set when discount type is none", [
			"bundleDiscountValueMinor",
			"bundleDiscountValueBps",
		]);
	}
}

function validateBundleDiscountPatchShape(ctx: z.RefinementCtx, input: BundleDiscountInput): void {
	const hasFixedAmountValue = input.bundleDiscountValueMinor !== undefined;
	const hasBpsValue = input.bundleDiscountValueBps !== undefined;

	if (input.bundleDiscountType === "fixed_amount" && hasBpsValue) {
		addBundleDiscountIssue(ctx, "bundleDiscountValueBps can only be used with percentage bundles", [
			"bundleDiscountValueBps",
		]);
	}

	if (input.bundleDiscountType === "percentage" && hasFixedAmountValue) {
		addBundleDiscountIssue(
			ctx,
			"bundleDiscountValueMinor can only be used with fixed-amount bundles",
			["bundleDiscountValueMinor"],
		);
	}
}

/**
 * Shared cart line item fragment — same invariants enforced at cart boundary
 * and re-checked at checkout (defence in depth, not duplication).
 */
export const cartLineItemSchema = z.object({
	productId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	variantId: z.string().min(0).max(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	quantity: z
		.number()
		.int()
		.min(1, "Quantity must be at least 1")
		.max(
			COMMERCE_LIMITS.maxLineItemQty,
			`Quantity must not exceed ${COMMERCE_LIMITS.maxLineItemQty}`,
		),
	/**
	 * Snapshot of the inventory version at the time the item was added to the cart.
	 * Used for optimistic concurrency during finalize.
	 */
	inventoryVersion: z.number().int().min(0, "Inventory version must be a non-negative integer"),
	/** Price in the smallest currency unit (e.g. cents). Must be non-negative. */
	unitPriceMinor: z.number().int().min(0, "Unit price must be a non-negative integer"),
});

export type CartLineItemInput = z.infer<typeof cartLineItemSchema>;

export const cartUpsertInputSchema = z.object({
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	currency: z.string().min(3).max(3).toUpperCase(),
	lineItems: z
		.array(cartLineItemSchema)
		.min(0)
		.max(
			COMMERCE_LIMITS.maxCartLineItems,
			`Cart must not exceed ${COMMERCE_LIMITS.maxCartLineItems} line items`,
		),
	/**
	 * Required when mutating an existing cart.
	 * Absent on first creation — the server issues a fresh token and returns it once.
	 */
	ownerToken: z.string().min(16).max(256).optional(),
});

export type CartUpsertInput = z.infer<typeof cartUpsertInputSchema>;

export const cartGetInputSchema = z.object({
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	/**
	 * Required to prove ownership for reads.
	 */
	ownerToken: z.string().min(16).max(256),
});

export type CartGetInput = z.infer<typeof cartGetInputSchema>;

export const checkoutInputSchema = z.object({
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	/** Optional when `Idempotency-Key` header is set. */
	idempotencyKey: z.string().optional(),
	/**
	 * Required for checkout to verify cart ownership.
	 */
	ownerToken: z.string().min(16).max(256),
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

/**
 * Possession proof for order read: must match checkout's `finalizeToken` for this `orderId`.
 */
export const checkoutGetOrderInputSchema = z.object({
	orderId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	finalizeToken: z.string().min(16).max(256),
});

export type CheckoutGetOrderInput = z.infer<typeof checkoutGetOrderInputSchema>;

const stripeWebhookEventDataSchema = z.object({
	id: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	type: z.string().min(1).max(128),
	data: z.object({
		object: z.object({
			id: z.string().min(1).max(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
			metadata: z
				.record(z.string(), z.string().max(COMMERCE_LIMITS.maxWebhookFieldLength))
				.optional(),
		}),
	}),
});

const stripeWebhookEventInputSchema = stripeWebhookEventDataSchema;

export const stripeWebhookInputSchema = stripeWebhookEventInputSchema;

export type StripeWebhookInput = z.infer<typeof stripeWebhookInputSchema>;
export type StripeWebhookEventInput = z.infer<typeof stripeWebhookEventDataSchema>;

export const recommendationsInputSchema = z.object({
	/** Hint for “similar to this product” (catalog id). */
	productId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	variantId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	limit: z.coerce.number().int().min(1).max(COMMERCE_LIMITS.maxRecommendationsLimit).optional(),
});

export type RecommendationsInput = z.infer<typeof recommendationsInputSchema>;

export const productCreateInputSchema = z
	.object({
		type: z.enum(["simple", "variable", "bundle"]).default("simple"),
		status: z.enum(["draft", "active", "archived"]).default("draft"),
		visibility: z.enum(["public", "hidden"]).default("hidden"),
		slug: z.string().trim().min(2).max(128).toLowerCase(),
		title: z.string().trim().min(1).max(160),
		shortDescription: z.string().trim().max(320).default(""),
		longDescription: z.string().trim().max(8_000).default(""),
		brand: z.string().trim().max(128).optional(),
		vendor: z.string().trim().max(128).optional(),
		featured: z.boolean().default(false),
		sortOrder: z.number().int().min(0).max(10_000).default(0),
		requiresShippingDefault: z.boolean().default(true),
		taxClassDefault: z.string().trim().max(64).optional(),
		attributes: z
			.array(
				z.object({
					name: z.string().trim().min(1).max(128),
					code: z.string().trim().min(1).max(64).toLowerCase(),
					kind: z.enum(["variant_defining", "descriptive"]).default("descriptive"),
					position: z.number().int().min(0).max(10_000).default(0),
					values: z
						.array(
							z.object({
								value: z.string().trim().min(1).max(128),
								code: z.string().trim().min(1).max(64).toLowerCase(),
								position: z.number().int().min(0).max(10_000).default(0),
							}),
						)
						.min(1)
						.default([]),
				}),
			)
			.default([]),
		bundleDiscountType: z.enum(["none", "fixed_amount", "percentage"]).default("none"),
		bundleDiscountValueMinor: z.number().int().min(0).optional(),
		bundleDiscountValueBps: z.number().int().min(0).max(10_000).optional(),
	})
	.superRefine((input, ctx) => {
		validateBundleDiscountForProductType(ctx, input.type, input);
	});
export type ProductCreateInput = z.input<typeof productCreateInputSchema>;

export const productGetInputSchema = z.object({
	productId: z.string().trim().min(3).max(128),
});
export type ProductGetInput = z.infer<typeof productGetInputSchema>;

export const productListInputSchema = z.object({
	type: z.enum(["simple", "variable", "bundle"]).optional(),
	status: z.enum(["draft", "active", "archived"]).optional(),
	visibility: z.enum(["public", "hidden"]).optional(),
	categoryId: bounded(128).optional(),
	tagId: bounded(128).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ProductListInput = z.infer<typeof productListInputSchema>;

export const productSkuCreateInputSchema = z.object({
	productId: z.string().trim().min(3).max(128),
	skuCode: z.string().trim().min(1).max(128),
	status: z.enum(["active", "inactive"]).default("active"),
	unitPriceMinor: z.number().int().min(0),
	compareAtPriceMinor: z.number().int().min(0).optional(),
	inventoryQuantity: z.number().int().min(0),
	inventoryVersion: z.number().int().min(0).default(1),
	requiresShipping: z.boolean().default(true),
	isDigital: z.boolean().default(false),
	optionValues: z
		.array(
			z.object({
				attributeId: z.string().trim().min(3).max(128),
				attributeValueId: z.string().trim().min(3).max(128),
			}),
		)
		.default([]),
});
export type ProductSkuCreateInput = z.input<typeof productSkuCreateInputSchema>;

export const productSkuListInputSchema = z.object({
	productId: z.string().trim().min(3).max(128),
	limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type ProductSkuListInput = z.infer<typeof productSkuListInputSchema>;

export const productUpdateInputSchema = z
	.object({
		productId: z.string().trim().min(3).max(128),
		type: z.enum(["simple", "variable", "bundle"]).optional(),
		status: z.enum(["draft", "active", "archived"]).optional(),
		visibility: z.enum(["public", "hidden"]).optional(),
		slug: z.string().trim().min(2).max(128).toLowerCase().optional(),
		title: z.string().trim().min(1).max(160).optional(),
		shortDescription: z.string().trim().max(320).optional(),
		longDescription: z.string().trim().max(8_000).optional(),
		brand: z.string().trim().max(128).optional(),
		vendor: z.string().trim().max(128).optional(),
		featured: z.boolean().optional(),
		sortOrder: z.number().int().min(0).max(10_000).optional(),
		requiresShippingDefault: z.boolean().optional(),
		taxClassDefault: z.string().trim().max(64).optional(),
		bundleDiscountType: z.enum(["none", "fixed_amount", "percentage"]).optional(),
		bundleDiscountValueMinor: z.number().int().min(0).optional(),
		bundleDiscountValueBps: z.number().int().min(0).max(10_000).optional(),
	})
	.superRefine((input, ctx) => {
		validateBundleDiscountPatchShape(ctx, input);
	});
export type ProductUpdateInput = z.infer<typeof productUpdateInputSchema>;

export const productStateInputSchema = z.object({
	productId: z.string().trim().min(3).max(128),
	status: z.enum(["draft", "active", "archived"]),
});
export type ProductStateInput = z.infer<typeof productStateInputSchema>;

export const productSkuUpdateInputSchema = z.object({
	skuId: z.string().trim().min(3).max(128),
	skuCode: z.string().trim().min(1).max(128).optional(),
	status: z.enum(["active", "inactive"]).optional(),
	unitPriceMinor: z.number().int().min(0).optional(),
	compareAtPriceMinor: z.number().int().min(0).optional(),
	inventoryQuantity: z.number().int().min(0).optional(),
	inventoryVersion: z.number().int().min(0).optional(),
	requiresShipping: z.boolean().optional(),
	isDigital: z.boolean().optional(),
});
export type ProductSkuUpdateInput = z.infer<typeof productSkuUpdateInputSchema>;

export const productSkuStateInputSchema = z.object({
	skuId: z.string().trim().min(3).max(128),
	status: z.enum(["active", "inactive"]),
});
export type ProductSkuStateInput = z.infer<typeof productSkuStateInputSchema>;

export const productAssetRegisterInputSchema = z
	.object({
		externalAssetId: bounded(128),
		provider: z.string().trim().min(1).max(64).default("media"),
		fileName: z.string().trim().max(260).optional(),
		altText: z.string().trim().max(260).optional(),
		mimeType: z.string().trim().max(128).optional(),
		byteSize: z.number().int().min(0).optional(),
		width: z.number().int().min(1).max(20_000).optional(),
		height: z.number().int().min(1).max(20_000).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type ProductAssetRegisterInput = z.infer<typeof productAssetRegisterInputSchema>;

export const productAssetLinkInputSchema = z
	.object({
		assetId: z.string().trim().min(3).max(128),
		targetType: z.enum(["product", "sku"]),
		targetId: z.string().trim().min(3).max(128),
		role: z.enum(["primary_image", "gallery_image", "variant_image"]).default("gallery_image"),
		position: z.number().int().min(0).default(0),
	})
	.strict();
export type ProductAssetLinkInput = z.input<typeof productAssetLinkInputSchema>;

export const productAssetUnlinkInputSchema = z
	.object({
		linkId: z.string().trim().min(3).max(128),
	})
	.strict();
export type ProductAssetUnlinkInput = z.infer<typeof productAssetUnlinkInputSchema>;

export const productAssetReorderInputSchema = z
	.object({
		linkId: z.string().trim().min(3).max(128),
		position: z.number().int().min(0),
	})
	.strict();
export type ProductAssetReorderInput = z.infer<typeof productAssetReorderInputSchema>;

export const bundleComponentAddInputSchema = z
	.object({
		bundleProductId: bounded(128),
		componentSkuId: bounded(128),
		quantity: z.number().int().min(1),
		position: z.number().int().min(0).default(0),
	})
	.strict();
export type BundleComponentAddInput = z.infer<typeof bundleComponentAddInputSchema>;

export const bundleComponentRemoveInputSchema = z
	.object({
		bundleComponentId: bounded(128),
	})
	.strict();
export type BundleComponentRemoveInput = z.infer<typeof bundleComponentRemoveInputSchema>;

export const bundleComponentReorderInputSchema = z
	.object({
		bundleComponentId: bounded(128),
		position: z.number().int().min(0),
	})
	.strict();
export type BundleComponentReorderInput = z.infer<typeof bundleComponentReorderInputSchema>;

export const bundleComputeInputSchema = z
	.object({
		productId: bounded(128),
	})
	.strict();
export type BundleComputeInput = z.infer<typeof bundleComputeInputSchema>;

export const categoryCreateInputSchema = z
	.object({
		name: z.string().trim().min(1).max(128),
		slug: z.string().trim().min(2).max(128).toLowerCase(),
		parentId: z.string().trim().min(3).max(128).optional(),
		position: z.number().int().min(0).max(10_000).default(0),
	})
	.strict();
export type CategoryCreateInput = z.infer<typeof categoryCreateInputSchema>;

export const categoryListInputSchema = z
	.object({
		parentId: z.string().trim().min(3).max(128).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(100),
	})
	.strict();
export type CategoryListInput = z.infer<typeof categoryListInputSchema>;

export const productCategoryLinkInputSchema = z
	.object({
		productId: bounded(128),
		categoryId: bounded(128),
	})
	.strict();
export type ProductCategoryLinkInput = z.infer<typeof productCategoryLinkInputSchema>;

export const productCategoryUnlinkInputSchema = z
	.object({
		linkId: bounded(128),
	})
	.strict();
export type ProductCategoryUnlinkInput = z.infer<typeof productCategoryUnlinkInputSchema>;

export const tagCreateInputSchema = z
	.object({
		name: z.string().trim().min(1).max(128),
		slug: z.string().trim().min(2).max(128).toLowerCase(),
	})
	.strict();
export type TagCreateInput = z.infer<typeof tagCreateInputSchema>;

export const tagListInputSchema = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).default(100),
	})
	.strict();
export type TagListInput = z.infer<typeof tagListInputSchema>;

export const productTagLinkInputSchema = z
	.object({
		productId: bounded(128),
		tagId: bounded(128),
	})
	.strict();
export type ProductTagLinkInput = z.infer<typeof productTagLinkInputSchema>;

export const productTagUnlinkInputSchema = z
	.object({
		linkId: bounded(128),
	})
	.strict();
export type ProductTagUnlinkInput = z.infer<typeof productTagUnlinkInputSchema>;

export const digitalAssetCreateInputSchema = z
	.object({
		externalAssetId: bounded(128),
		provider: z.string().trim().min(1).max(64).default("media"),
		label: z.string().trim().max(260).optional(),
		downloadLimit: z.number().int().min(1).optional(),
		downloadExpiryDays: z.number().int().min(1).optional(),
		isManualOnly: z.boolean().default(false),
		isPrivate: z.boolean().default(true),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type DigitalAssetCreateInput = z.input<typeof digitalAssetCreateInputSchema>;

export const digitalEntitlementCreateInputSchema = z
	.object({
		skuId: bounded(128),
		digitalAssetId: bounded(128),
		grantedQuantity: z.number().int().min(1).default(1),
	})
	.strict();
export type DigitalEntitlementCreateInput = z.infer<typeof digitalEntitlementCreateInputSchema>;

export const digitalEntitlementRemoveInputSchema = z
	.object({
		entitlementId: bounded(128),
	})
	.strict();
export type DigitalEntitlementRemoveInput = z.infer<typeof digitalEntitlementRemoveInputSchema>;
