import type { RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import { normalizeOrderedChildren, normalizeOrderedPosition, mutateOrderedChildren, sortOrderedRowsByPosition } from "../lib/ordered-rows.js";
import { randomHex } from "../lib/crypto-adapter.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import { hydrateSkusWithInventoryStock } from "./catalog-read-model.js";
import { computeBundleSummary } from "../lib/catalog-bundles.js";
import type {
	BundleComponentAddInput,
	BundleComponentRemoveInput,
	BundleComponentReorderInput,
	BundleComputeInput,
} from "../schemas.js";
import type { StoredBundleComponent, StoredInventoryStock, StoredProduct, StoredProductSku } from "../types.js";
import type {
	BundleComponentResponse,
	BundleComponentUnlinkResponse,
	BundleComputeResponse,
} from "./catalog.js";
import { queryAllPages } from "./catalog-read-model.js";
import type { Collection } from "./catalog-conflict.js";
import {
	asCollection,
	asOptionalCollection,
	getNowIso,
	putWithConflictHandling,
} from "./catalog-conflict.js";

export async function queryBundleComponentsForProduct(
	bundleComponents: Collection<StoredBundleComponent>,
	bundleProductId: string,
): Promise<StoredBundleComponent[]> {
	const links = await queryAllPages((cursor) =>
		bundleComponents.query({
			where: { bundleProductId },
			cursor,
			limit: 100,
		}),
	);
	const rows = sortOrderedRowsByPosition(links.map((row) => row.data));
	return normalizeOrderedChildren(rows);
}

export async function handleAddBundleComponent(
	ctx: RouteContext<BundleComponentAddInput>,
): Promise<BundleComponentResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);
	const nowIso = getNowIso();

	const bundleProduct = await products.get(ctx.input.bundleProductId);
	if (!bundleProduct) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle product not found" });
	}
	if (bundleProduct.type !== "bundle") {
		throw PluginRouteError.badRequest("Target product is not a bundle");
	}

	const componentSku = await productSkus.get(ctx.input.componentSkuId);
	if (!componentSku) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "Component SKU not found" });
	}
	if (componentSku.productId === bundleProduct.id) {
		throw PluginRouteError.badRequest("Bundle cannot include component from itself");
	}
	const componentProduct = await products.get(componentSku.productId);
	if (!componentProduct) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Component product not found" });
	}
	if (componentProduct.type === "bundle") {
		throw PluginRouteError.badRequest("Bundle cannot include component products that are themselves bundles");
	}

	const existingComponents = await queryBundleComponentsForProduct(bundleComponents, bundleProduct.id);
	const requestedPosition = normalizeOrderedPosition(ctx.input.position);
	const componentId = `bundle_comp_${await randomHex(6)}`;
	const component: StoredBundleComponent = {
		id: componentId,
		bundleProductId: bundleProduct.id,
		componentSkuId: componentSku.id,
		quantity: ctx.input.quantity,
		position: requestedPosition,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await putWithConflictHandling(bundleComponents, componentId, component, {
		where: { bundleProductId: bundleProduct.id, componentSkuId: ctx.input.componentSkuId },
		message: "Bundle already contains this component SKU",
	});

	let normalized: StoredBundleComponent[];
	try {
		normalized = await mutateOrderedChildren({
			collection: bundleComponents,
			rows: existingComponents,
			mutation: {
				kind: "add",
				row: component,
				requestedPosition,
			},
			nowIso,
		});
	} catch (error) {
		await bundleComponents.delete(componentId);
		throw error;
	}

	const added = normalized.find((candidate) => candidate.id === componentId);
	if (!added) {
		throw PluginRouteError.badRequest("Bundle component not found after add");
	}
	return { component: added };
}

export async function handleRemoveBundleComponent(
	ctx: RouteContext<BundleComponentRemoveInput>,
): Promise<BundleComponentUnlinkResponse> {
	requirePost(ctx);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);
	const nowIso = getNowIso();

	const existing = await bundleComponents.get(ctx.input.bundleComponentId);
	if (!existing) {
		throwCommerceApiError({ code: "BUNDLE_COMPONENT_NOT_FOUND", message: "Bundle component not found" });
	}
	const components = await queryBundleComponentsForProduct(bundleComponents, existing.bundleProductId);
	await mutateOrderedChildren({
		collection: bundleComponents,
		rows: components,
		mutation: {
			kind: "remove",
			removedRowId: ctx.input.bundleComponentId,
		},
		nowIso,
	});
	return { deleted: true };
}

export async function handleReorderBundleComponent(
	ctx: RouteContext<BundleComponentReorderInput>,
): Promise<BundleComponentResponse> {
	requirePost(ctx);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);
	const nowIso = getNowIso();

	const component = await bundleComponents.get(ctx.input.bundleComponentId);
	if (!component) {
		throwCommerceApiError({ code: "BUNDLE_COMPONENT_NOT_FOUND", message: "Bundle component not found" });
	}

	const components = await queryBundleComponentsForProduct(bundleComponents, component.bundleProductId);
	const requestedPosition = normalizeOrderedPosition(ctx.input.position);
	const normalized = await mutateOrderedChildren({
		collection: bundleComponents,
		rows: components,
		mutation: {
			kind: "move",
			rowId: ctx.input.bundleComponentId,
			requestedPosition,
			notFoundMessage: "Bundle component not found in target bundle",
		},
		nowIso,
	});

	const updated = normalized.find((row) => row.id === ctx.input.bundleComponentId);
	if (!updated) {
		throw PluginRouteError.badRequest("Bundle component not found after reorder");
	}
	return { component: updated };
}

export async function handleBundleCompute(
	ctx: RouteContext<BundleComputeInput>,
): Promise<BundleComputeResponse> {
	requirePost(ctx);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const inventoryStock = asOptionalCollection<StoredInventoryStock>(ctx.storage.inventoryStock);
	const bundleComponents = asCollection<StoredBundleComponent>(ctx.storage.bundleComponents);

	const product = await products.get(ctx.input.productId);
	if (!product) {
		throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
	}
	if (product.type !== "bundle") {
		throw PluginRouteError.badRequest("Product is not a bundle");
	}

	const components = await queryBundleComponentsForProduct(bundleComponents, product.id);
	const lines: Array<{ component: StoredBundleComponent; sku: StoredProductSku }> = [];
	for (const component of components) {
		const sku = await productSkus.get(component.componentSkuId);
		if (!sku) {
			throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "Bundle component SKU not found" });
		}
		const componentProduct = await products.get(sku.productId);
		if (!componentProduct) {
			throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Bundle component product not found" });
		}
		const hydratedSkus = await hydrateSkusWithInventoryStock(componentProduct, [sku], inventoryStock);
		lines.push({ component, sku: hydratedSkus[0] ?? sku });
	}

	return computeBundleSummary(
		product.id,
		product.bundleDiscountType,
		product.bundleDiscountValueMinor,
		product.bundleDiscountValueBps,
		lines,
	);
}
