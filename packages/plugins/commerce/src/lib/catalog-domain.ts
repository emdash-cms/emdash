import { PluginRouteError } from "emdash";

import type {
	StoredProduct,
	StoredProductSku,
} from "../types.js";
import type {
	ProductSkuUpdateInput as ProductSkuUpdateInputSchema,
	ProductUpdateInput as ProductUpdateInputSchema,
} from "../schemas.js";

export const PRODUCT_IMMUTABLE_FIELDS = [
	"id",
	"type",
	"createdAt",
] as const satisfies readonly (keyof StoredProduct)[];

export const PRODUCT_SKU_IMMUTABLE_FIELDS = [
	"id",
	"productId",
	"createdAt",
] as const satisfies readonly (keyof StoredProductSku)[];

type ProductPatch = Omit<ProductUpdateInputSchema, "productId">;
type ProductSkuPatch = Omit<ProductSkuUpdateInputSchema, "skuId">;

type DraftProductForLifecycle = Pick<
	StoredProduct,
	"publishedAt" | "archivedAt" | "status"
>;

export function applyProductUpdatePatch<T extends ProductPatch>(
	existing: StoredProduct,
	patch: T,
	nowIso: string,
): StoredProduct {
	const patchMap = patch as Record<string, unknown>;

	for (const field of PRODUCT_IMMUTABLE_FIELDS) {
		const proposed = patchMap[field];
		if (proposed !== undefined && proposed !== existing[field]) {
			throw PluginRouteError.badRequest(`Cannot update immutable field: ${field}`);
		}
	}

	if (
		patch.slug !== undefined &&
		existing.status === "active" &&
		patch.slug !== existing.slug
	) {
		throw PluginRouteError.badRequest("Cannot change slug after a product is active");
	}

	const next = applyProductLifecycle(
		{
			...existing,
			...patch,
			updatedAt: nowIso,
		},
		nowIso,
	);
	return next;
}

export function applyProductSkuUpdatePatch<T extends ProductSkuPatch>(
	existing: StoredProductSku,
	patch: T,
	nowIso: string,
): StoredProductSku {
	const patchMap = patch as Record<string, unknown>;
	for (const field of PRODUCT_SKU_IMMUTABLE_FIELDS) {
		const proposed = patchMap[field];
		if (proposed !== undefined && proposed !== existing[field]) {
			throw PluginRouteError.badRequest(`Cannot update immutable field: ${field}`);
		}
	}

	return {
		...existing,
		...patch,
		updatedAt: nowIso,
	};
}

function applyProductLifecycle<T extends DraftProductForLifecycle & StoredProduct>(
	product: T,
	nowIso: string,
): T {
	if (product.status === "active") {
		return {
			...product,
			publishedAt: product.publishedAt ?? nowIso,
			archivedAt: undefined,
		};
	}

	if (product.status === "archived") {
		return {
			...product,
			archivedAt: nowIso,
		};
	}

	return {
		...product,
		archivedAt: undefined,
		publishedAt: product.publishedAt,
	};
}

