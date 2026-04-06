import type { RouteContext, StorageCollection } from "emdash";
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
import {
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

type Collection<T> = StorageCollection<T>;
type CollectionWithUniqueInsert<T> = Collection<T> & {
	putIfAbsent?: (id: string, data: T) => Promise<boolean>;
};

type ConflictHint = {
	where: Record<string, unknown>;
	message: string;
};

function getNowIso(): string {
	return new Date(Date.now()).toISOString();
}

function asCollection<T>(raw: unknown): Collection<T> {
	return raw as Collection<T>;
}

function looksLikeUniqueConstraintMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("unique constraint failed") ||
		normalized.includes("uniqueness violation") ||
		normalized.includes("duplicate key value violates unique constraint") ||
		normalized.includes("duplicate entry") ||
		normalized.includes("constraint failed:") ||
		normalized.includes("sqlerrorcode=primarykey")
	);
}

function readErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const maybeCode = (error as Record<string, unknown>).code;
	if (typeof maybeCode === "string" && maybeCode.length > 0) {
		return maybeCode;
	}
	if (typeof maybeCode === "number") {
		return String(maybeCode);
	}
	const maybeCause = (error as Record<string, unknown>).cause;
	return typeof maybeCause === "object" ? readErrorCode(maybeCause) : undefined;
}

function isUniqueConstraintViolation(error: unknown, seen = new Set<unknown>()): boolean {
	if (error == null || seen.has(error)) return false;
	seen.add(error);

	if (readErrorCode(error) === "23505") return true;

	if (error instanceof Error) {
		if (looksLikeUniqueConstraintMessage(error.message)) return true;
		return isUniqueConstraintViolation((error as Error & { cause?: unknown }).cause, seen);
	}

	if (typeof error === "object") {
		const record = error as Record<string, unknown>;
		const message = record.message;
		if (typeof message === "string" && looksLikeUniqueConstraintMessage(message)) return true;
		const cause = record.cause;
		if (cause) {
			return isUniqueConstraintViolation(cause, seen);
		}
	}

	return false;
}

function throwConflict(message: string): never {
	throw PluginRouteError.badRequest(message);
}

async function putWithConflictHandling<T extends object>(
	collection: CollectionWithUniqueInsert<T>,
	id: string,
	data: T,
	conflict?: ConflictHint,
): Promise<void> {
	if (collection.putIfAbsent) {
		try {
			const inserted = await collection.putIfAbsent(id, data);
			if (!inserted) {
				throwConflict(conflict?.message ?? "Resource already exists");
			}
			return;
		} catch (error) {
			if (isUniqueConstraintViolation(error) && conflict) {
				throwConflict(conflict.message);
			}
			throw error;
		}
	}

	if (conflict) {
		const rows = await collection.query({ where: conflict.where, limit: 2 });
		for (const item of rows.items) {
			throwConflict(conflict.message ?? "Resource already exists");
		}
	}

	await collection.put(id, data);
}

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
