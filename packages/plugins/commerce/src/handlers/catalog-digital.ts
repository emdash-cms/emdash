import { PluginRouteError } from "emdash";
import type { RouteContext, StorageCollection } from "emdash";

import { randomHex } from "../lib/crypto-adapter.js";
import { requirePost } from "../lib/require-post.js";
import { throwCommerceApiError } from "../route-errors.js";
import type {
	DigitalAssetCreateInput,
	DigitalEntitlementCreateInput,
	DigitalEntitlementRemoveInput,
} from "../schemas.js";
import type { StoredDigitalAsset, StoredDigitalEntitlement, StoredProductSku } from "../types.js";
import type {
	DigitalAssetResponse,
	DigitalEntitlementResponse,
	DigitalEntitlementUnlinkResponse,
} from "./catalog.js";

type Collection<T> = StorageCollection<T>;
type CollectionWithUniqueInsert<T> = Collection<T> & {
	putIfAbsent?: (id: string, data: T) => Promise<boolean>;
};

type ConflictHint = {
	where: Record<string, unknown>;
	message: string;
};

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
		for (const _ of rows.items) {
			throwConflict(conflict.message ?? "Resource already exists");
		}
	}

	await collection.put(id, data);
}

function getNowIso(): string {
	return new Date(Date.now()).toISOString();
}

export async function handleCreateDigitalAsset(ctx: RouteContext<DigitalAssetCreateInput>): Promise<DigitalAssetResponse> {
	requirePost(ctx);
	const provider = ctx.input.provider ?? "media";
	const isManualOnly = ctx.input.isManualOnly ?? false;
	const isPrivate = ctx.input.isPrivate ?? true;
	const productDigitalAssets = asCollection<StoredDigitalAsset>(ctx.storage.digitalAssets);
	const nowIso = getNowIso();

	const id = `digital_asset_${await randomHex(6)}`;
	const asset: StoredDigitalAsset = {
		id,
		provider,
		externalAssetId: ctx.input.externalAssetId,
		label: ctx.input.label,
		downloadLimit: ctx.input.downloadLimit,
		downloadExpiryDays: ctx.input.downloadExpiryDays,
		isManualOnly,
		isPrivate,
		metadata: ctx.input.metadata,
		createdAt: nowIso,
		updatedAt: nowIso,
	};

	await putWithConflictHandling(productDigitalAssets, id, asset, {
		where: { provider, externalAssetId: ctx.input.externalAssetId },
		message: "Digital asset already registered for provider key",
	});
	return { asset };
}

export async function handleCreateDigitalEntitlement(
	ctx: RouteContext<DigitalEntitlementCreateInput>,
): Promise<DigitalEntitlementResponse> {
	requirePost(ctx);
	const productSkus = asCollection<StoredProductSku>(ctx.storage.productSkus);
	const productDigitalAssets = asCollection<StoredDigitalAsset>(ctx.storage.digitalAssets);
	const productDigitalEntitlements = asCollection<StoredDigitalEntitlement>(ctx.storage.digitalEntitlements);
	const nowIso = getNowIso();

	const sku = await productSkus.get(ctx.input.skuId);
	if (!sku) {
		throwCommerceApiError({ code: "VARIANT_UNAVAILABLE", message: "SKU not found" });
	}
	if (sku.status !== "active") {
		throw PluginRouteError.badRequest(`Cannot attach entitlement to inactive SKU ${ctx.input.skuId}`);
	}

	const digitalAsset = await productDigitalAssets.get(ctx.input.digitalAssetId);
	if (!digitalAsset) {
		throwCommerceApiError({ code: "DIGITAL_ASSET_NOT_FOUND", message: "Digital asset not found" });
	}

	const id = `entitlement_${await randomHex(6)}`;
	const entitlement: StoredDigitalEntitlement = {
		id,
		skuId: ctx.input.skuId,
		digitalAssetId: ctx.input.digitalAssetId,
		grantedQuantity: ctx.input.grantedQuantity,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
	await putWithConflictHandling(productDigitalEntitlements, id, entitlement, {
		where: { skuId: ctx.input.skuId, digitalAssetId: ctx.input.digitalAssetId },
		message: "SKU already has this digital entitlement",
	});
	return { entitlement };
}

export async function handleRemoveDigitalEntitlement(
	ctx: RouteContext<DigitalEntitlementRemoveInput>,
): Promise<DigitalEntitlementUnlinkResponse> {
	requirePost(ctx);
	const productDigitalEntitlements = asCollection<StoredDigitalEntitlement>(ctx.storage.digitalEntitlements);

	const existing = await productDigitalEntitlements.get(ctx.input.entitlementId);
	if (!existing) {
		throwCommerceApiError({ code: "DIGITAL_ENTITLEMENT_NOT_FOUND", message: "Digital entitlement not found" });
	}
	await productDigitalEntitlements.delete(ctx.input.entitlementId);
	return { deleted: true };
}
