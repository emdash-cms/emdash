import type { RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import { randomHex } from "../lib/crypto-adapter.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import {
	mutateOrderedChildren,
	normalizeOrderedChildren,
	normalizeOrderedPosition,
	sortOrderedRowsByPosition,
} from "../lib/ordered-rows.js";
import type {
	ProductAssetLinkInput,
	ProductAssetReorderInput,
	ProductAssetRegisterInput,
	ProductAssetUnlinkInput,
} from "../schemas.js";
import type { ProductAssetLinkTarget, StoredProduct, StoredProductAsset, StoredProductAssetLink, StoredProductSku } from "../types.js";
import type {
	ProductAssetResponse,
	ProductAssetLinkResponse,
	ProductAssetUnlinkResponse,
} from "./catalog.js";
import { queryAllPages } from "./catalog-read-model.js";
import type { Collection } from "./catalog-conflict.js";
import {
	asCollection,
	getNowIso,
	putWithConflictHandling,
} from "./catalog-conflict.js";

async function queryAssetLinksForTarget(
	productAssetLinks: Collection<StoredProductAssetLink>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
): Promise<StoredProductAssetLink[]> {
	const rows = await queryAllPages((cursor) =>
		productAssetLinks.query({
			where: { targetType, targetId },
			cursor,
			limit: 100,
		}),
	);
	return normalizeOrderedChildren(sortOrderedRowsByPosition(rows.map((row) => row.data)));
}

async function loadCatalogTargetExists(
	products: Collection<StoredProduct>,
	productSkus: Collection<StoredProductSku>,
	targetType: ProductAssetLinkTarget,
	targetId: string,
) {
	if (targetType === "product") {
		const product = await products.get(targetId);
		if (!product) {
			throwCommerceApiError({ code: "PRODUCT_UNAVAILABLE", message: "Product not found" });
		}
		return;
	}

	const sku = await productSkus.get(targetId);
	if (!sku) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}
}

export async function handleRegisterProductAsset(
	ctx: RouteContext<ProductAssetRegisterInput>,
): Promise<ProductAssetResponse> {
	requirePost(ctx);
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const nowIso = getNowIso();

	const id = `asset_${await randomHex(6)}`;
	const asset: StoredProductAsset = {
		id,
		provider: ctx.input.provider,
		externalAssetId: ctx.input.externalAssetId,
		fileName: ctx.input.fileName,
		altText: ctx.input.altText,
		mimeType: ctx.input.mimeType,
		byteSize: ctx.input.byteSize,
		width: ctx.input.width,
		height: ctx.input.height,
		metadata: ctx.input.metadata,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	await putWithConflictHandling(productAssets, id, asset, {
		where: {
			provider: ctx.input.provider,
			externalAssetId: ctx.input.externalAssetId,
		},
		message: "Asset metadata already registered for provider asset key",
	});
	return { asset };
}

export async function handleLinkCatalogAsset(
	ctx: RouteContext<ProductAssetLinkInput>,
): Promise<ProductAssetLinkResponse> {
	requirePost(ctx);
	const role = ctx.input.role ?? "gallery_image";
	const position = ctx.input.position ?? 0;
	const nowIso = getNowIso();
	const productAssets = asCollection<StoredProductAsset>(ctx.storage.productAssets);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const products = asCollection<StoredProduct>(ctx.storage.products);
	const skus = asCollection<StoredProductSku>(ctx.storage.productSkus);

	const targetType = ctx.input.targetType;
	const targetId = ctx.input.targetId;

	const asset = await productAssets.get(ctx.input.assetId);
	if (!asset) {
		throwCommerceApiError({ code: "ASSET_NOT_FOUND", message: "Asset not found" });
	}

	await loadCatalogTargetExists(products, skus, targetType, targetId);

	const links = await queryAssetLinksForTarget(productAssetLinks, targetType, targetId);
	if (role === "primary_image") {
		const hasPrimary = links.some((link) => link.role === "primary_image");
		if (hasPrimary) {
			throw PluginRouteError.badRequest("Target already has a primary image");
		}
	}

	const linkId = `asset_link_${await randomHex(6)}`;
	const requestedPosition = normalizeOrderedPosition(position);

	const link: StoredProductAssetLink = {
		id: linkId,
		targetType,
		targetId,
		assetId: ctx.input.assetId,
		role,
		position: requestedPosition,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await putWithConflictHandling(productAssetLinks, linkId, link, {
		where: {
			targetType,
			targetId,
			assetId: ctx.input.assetId,
		},
		message: "Asset already linked to this target",
	});

	let normalized: StoredProductAssetLink[];
	try {
		normalized = await mutateOrderedChildren({
			collection: productAssetLinks,
			rows: links,
			mutation: {
				kind: "add",
				row: link,
				requestedPosition,
			},
			nowIso,
		});
	} catch (error) {
		await productAssetLinks.delete(linkId);
		throw error;
	}

	const created = normalized.find((candidate) => candidate.id === linkId);
	if (!created) {
		throw PluginRouteError.badRequest("Asset link not found after create");
	}
	return { link: created };
}

export async function handleUnlinkCatalogAsset(
	ctx: RouteContext<ProductAssetUnlinkInput>,
): Promise<ProductAssetUnlinkResponse> {
	requirePost(ctx);
	const nowIso = getNowIso();
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const existing = await productAssetLinks.get(ctx.input.linkId);
	if (!existing) {
		throwCommerceApiError({ code: "ASSET_LINK_NOT_FOUND", message: "Asset link not found" });
	}
	const links = await queryAssetLinksForTarget(productAssetLinks, existing.targetType, existing.targetId);

	await mutateOrderedChildren({
		collection: productAssetLinks,
		rows: links,
		mutation: {
			kind: "remove",
			removedRowId: ctx.input.linkId,
		},
		nowIso,
	});

	return { deleted: true };
}

export async function handleReorderCatalogAsset(
	ctx: RouteContext<ProductAssetReorderInput>,
): Promise<ProductAssetLinkResponse> {
	requirePost(ctx);
	const productAssetLinks = asCollection<StoredProductAssetLink>(ctx.storage.productAssetLinks);
	const nowIso = getNowIso();

	const link = await productAssetLinks.get(ctx.input.linkId);
	if (!link) {
		throwCommerceApiError({ code: "ASSET_LINK_NOT_FOUND", message: "Asset link not found" });
	}

	const links = await queryAssetLinksForTarget(productAssetLinks, link.targetType, link.targetId);
	const requestedPosition = normalizeOrderedPosition(ctx.input.position);
	const normalized = await mutateOrderedChildren({
		collection: productAssetLinks,
		rows: links,
		mutation: {
			kind: "move",
			rowId: ctx.input.linkId,
			requestedPosition,
			notFoundMessage: "Asset link not found in target links",
		},
		nowIso,
	});

	const updated = normalized.find((candidate) => candidate.id === ctx.input.linkId);
	if (!updated) {
		throw PluginRouteError.badRequest("Asset link not found after reorder");
	}
	return { link: updated };
}
