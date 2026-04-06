import { PluginRouteError } from "emdash";
import type { RouteContext } from "emdash";

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
import type { Collection } from "./catalog-conflict.js";
import { asCollection, getNowIso, putWithConflictHandling } from "./catalog-conflict.js";

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
