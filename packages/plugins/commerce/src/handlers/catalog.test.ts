import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import type {
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductSku,
} from "../types.js";
import type {
	ProductAssetLinkInput,
	ProductAssetReorderInput,
	ProductAssetRegisterInput,
	ProductAssetUnlinkInput,
	ProductSkuCreateInput,
	ProductCreateInput,
} from "../schemas.js";
import {
	productAssetLinkInputSchema,
	productAssetReorderInputSchema,
	productAssetRegisterInputSchema,
	productAssetUnlinkInputSchema,
} from "../schemas.js";
import {
	createProductHandler,
	setProductStateHandler,
	createProductSkuHandler,
	getProductHandler,
	setSkuStatusHandler,
	updateProductHandler,
	updateProductSkuHandler,
	linkCatalogAssetHandler,
	reorderCatalogAssetHandler,
	registerProductAssetHandler,
	unlinkCatalogAssetHandler,
	listProductsHandler,
	listProductSkusHandler,
} from "./catalog.js";

class MemColl<T extends object> {
	constructor(public readonly rows = new Map<string, T>()) {}

	async get(id: string): Promise<T | null> {
		const row = this.rows.get(id);
		return row ? structuredClone(row) : null;
	}

	async put(id: string, data: T): Promise<void> {
		this.rows.set(id, structuredClone(data));
	}

	async delete(id: string): Promise<boolean> {
		return this.rows.delete(id);
	}

	async query(options?: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string; data: T }>; hasMore: boolean }> {
		const where = options?.where ?? {};
		const values = [...this.rows.entries()].filter(([, row]) =>
			Object.entries(where).every(([field, expected]) =>
				(row as Record<string, unknown>)[field] === expected,
			),
		);
		const items = values
			.slice(0, options?.limit ?? 50)
			.map(([id, row]) => ({ id, data: structuredClone(row) }));
		return { items, hasMore: false };
	}
}

function catalogCtx<TInput>(
	input: TInput,
	products: MemColl<StoredProduct>,
	productSkus = new MemColl<StoredProductSku>(),
	productAssets = new MemColl<StoredProductAsset>(),
	productAssetLinks = new MemColl<StoredProductAssetLink>(),
): RouteContext<TInput> {
	return {
		request: new Request("https://example.test/catalog", { method: "POST" }),
		input,
		storage: { products, productSkus, productAssets, productAssetLinks },
		requestMeta: { ip: "127.0.0.1" },
		kv: {},
	} as unknown as RouteContext<TInput>;
}

describe("catalog product handlers", () => {
	it("creates a product and persists it in storage", async () => {
		const products = new MemColl<StoredProduct>();
		const out = await createProductHandler(
			catalogCtx(
				{
					type: "simple",
					status: "draft",
					visibility: "hidden",
					slug: "simple-runner",
					title: "Simple Runner",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
				},
				products,
			),
		);

		expect(out.product.id).toMatch(/^prod_/);
		expect(products.rows.size).toBe(1);
	});

	it("rejects duplicate product slugs", async () => {
		const products = new MemColl<StoredProduct>();
		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "dup",
			title: "Existing",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const ctx = catalogCtx<ProductCreateInput>(
			{
				type: "simple",
				status: "draft",
				visibility: "hidden",
				slug: "dup",
				title: "Duplicate",
				shortDescription: "",
				longDescription: "",
				featured: false,
				sortOrder: 1,
				requiresShippingDefault: true,
			},
			products,
		);
		await expect(createProductHandler(ctx)).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("updates mutable product fields and preserves immutable fields", async () => {
		const products = new MemColl<StoredProduct>();
		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "draft",
			visibility: "hidden",
			slug: "editable",
			title: "Original",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			archivedAt: undefined,
			publishedAt: undefined,
		});

		const out = await updateProductHandler(
			catalogCtx(
				{
					productId: "prod_1",
					title: "Updated Title",
					featured: true,
				},
				products,
			),
		);

		expect(out.product.title).toBe("Updated Title");
		expect(out.product.featured).toBe(true);
		expect(out.product.id).toBe("prod_1");
		expect(out.product.type).toBe("simple");
		expect(out.product.createdAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("rejects immutable product field updates", async () => {
		const products = new MemColl<StoredProduct>();
		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "draft",
			visibility: "hidden",
			slug: "immutable",
			title: "Original",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const out = updateProductHandler(
			catalogCtx(
				{
					productId: "prod_1",
					type: "bundle",
				},
				products,
			),
		);
		await expect(out).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("sets product status transitions", async () => {
		const products = new MemColl<StoredProduct>();
		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "draft",
			visibility: "hidden",
			slug: "stateful",
			title: "State",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const archived = await setProductStateHandler(
			catalogCtx(
				{
					productId: "prod_1",
					status: "archived",
				},
				products,
			),
		);
		expect(archived.product.status).toBe("archived");
		expect(archived.product.archivedAt).toBeTypeOf("string");

		const draft = await setProductStateHandler(
			catalogCtx(
				{
					productId: "prod_1",
					status: "draft",
				},
				products,
			),
		);
		expect(draft.product.status).toBe("draft");
		expect(draft.product.archivedAt).toBeUndefined();
	});

	it("lists products filtered by status and type", async () => {
		const products = new MemColl<StoredProduct>();
		await products.put("p1", {
			id: "p1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "alpha",
			title: "Alpha",
			shortDescription: "",
			longDescription: "",
			featured: true,
			sortOrder: 10,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await products.put("p2", {
			id: "p2",
			type: "simple",
			status: "draft",
			visibility: "hidden",
			slug: "beta",
			title: "Beta",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 5,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const out = await listProductsHandler(
			catalogCtx(
				{
					type: "simple",
					status: "active",
					visibility: undefined,
					limit: 20,
				},
				products,
			),
		);
		expect(out.items).toHaveLength(1);
		expect(out.items[0]!.id).toBe("p1");
	});

	it("returns product_unavailable when productId does not exist", async () => {
		const out = getProductHandler(catalogCtx({ productId: "missing" }, new MemColl()));
		await expect(out).rejects.toMatchObject({ code: "product_unavailable" });
	});
});

describe("catalog SKU handlers", () => {
	it("creates SKU rows and lists them by productId", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		await products.put("parent", {
			id: "parent",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "parent",
			title: "Parent",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const createSkuCtx = catalogCtx<ProductSkuCreateInput>(
			{
				productId: "parent",
				skuCode: "SIMPLE-A",
				status: "active",
				unitPriceMinor: 1299,
				inventoryQuantity: 10,
				inventoryVersion: 1,
				requiresShipping: true,
				isDigital: false,
			},
			products,
			skus,
		);
		const created = await createProductSkuHandler(createSkuCtx);
		expect(created.sku.skuCode).toBe("SIMPLE-A");
		expect(created.sku.id).toMatch(/^sku_/);

		const listCtx = catalogCtx({ productId: "parent", limit: 10 }, products, skus);
		const listed = await listProductSkusHandler(listCtx);
		expect(listed.items).toHaveLength(1);
		expect(listed.items[0]!.id).toBe(created.sku.id);
	});

	it("updates SKU fields without changing immutable identifiers", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		await products.put("parent", {
			id: "parent",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "parent",
			title: "Parent",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const created = await createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: "parent",
					skuCode: "SIMPLE-A",
					status: "active",
					unitPriceMinor: 1299,
					inventoryQuantity: 10,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
				},
				products,
				skus,
			),
		);

		const updated = await updateProductSkuHandler(
			catalogCtx(
				{
					skuId: created.sku.id,
					unitPriceMinor: 1499,
				},
				products,
				skus,
			),
		);
		expect(updated.sku.unitPriceMinor).toBe(1499);
		expect(updated.sku.productId).toBe("parent");
	});

	it("sets SKU active/inactive state", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		await products.put("parent", {
			id: "parent",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "parent",
			title: "Parent",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const created = await createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: "parent",
					skuCode: "SIMPLE-A",
					status: "active",
					unitPriceMinor: 1299,
					inventoryQuantity: 10,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
				},
				products,
				skus,
			),
		);

		const archived = await setSkuStatusHandler(
			catalogCtx(
				{
					skuId: created.sku.id,
					status: "inactive",
				},
				products,
				skus,
			),
		);
		expect(archived.sku.status).toBe("inactive");
	});
});

describe("catalog asset handlers", () => {
	it("rejects binary-upload payload keys at the contract boundary", () => {
		expect(
			productAssetRegisterInputSchema.safeParse({
				externalAssetId: "media-1",
				provider: "media",
				file: "should-not-be-uploaded",
			}).success,
		).toBe(false);

		expect(
			productAssetLinkInputSchema.safeParse({
				assetId: "asset_1",
				targetType: "product",
				targetId: "prod_1",
				role: "gallery_image",
				position: 0,
				stream: "binary",
			}).success,
		).toBe(false);

		expect(
			productAssetUnlinkInputSchema.safeParse({
				linkId: "link_1",
				file: "should-not-be-uploaded",
			}).success,
		).toBe(false);

		expect(
			productAssetReorderInputSchema.safeParse({
				linkId: "link_1",
				position: 0,
				body: "not-expected",
			}).success,
		).toBe(false);
	});

	it("registers provider-agnostic asset metadata without binary payload", async () => {
		const productAssets = new MemColl<StoredProductAsset>();

		const out = await registerProductAssetHandler(
			catalogCtx<ProductAssetRegisterInput>(
				{
					externalAssetId: "media-123",
					provider: "media",
					fileName: "hero.jpg",
					mimeType: "image/jpeg",
					byteSize: 123_456,
				},
				new MemColl(),
				new MemColl(),
				productAssets,
			),
		);

		expect(out.asset.id).toMatch(/^asset_/);
		expect(out.asset.provider).toBe("media");
		expect(out.asset.externalAssetId).toBe("media-123");
		expect(out.asset.mimeType).toBe("image/jpeg");
	});

	it("links media metadata rows to a product and enforces one primary image per target", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const productAssets = new MemColl<StoredProductAsset>();
		const productAssetLinks = new MemColl<StoredProductAssetLink>();
		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "base",
			title: "Base",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		await productAssets.put("asset_1", {
			id: "asset_1",
			provider: "media",
			externalAssetId: "media-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await productAssets.put("asset_2", {
			id: "asset_2",
			provider: "media",
			externalAssetId: "media-2",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const first = await linkCatalogAssetHandler(
			catalogCtx<ProductAssetLinkInput>(
				{
					assetId: "asset_1",
					targetType: "product",
					targetId: "prod_1",
					role: "primary_image",
					position: 0,
				},
				products,
				skus,
				productAssets,
				productAssetLinks,
			),
		);
		expect(first.link.role).toBe("primary_image");
		expect(first.link.targetType).toBe("product");
		expect(first.link.targetId).toBe("prod_1");

		const duplicatePrimary = linkCatalogAssetHandler(
			catalogCtx<ProductAssetLinkInput>(
				{
					assetId: "asset_2",
					targetType: "product",
					targetId: "prod_1",
					role: "primary_image",
					position: 1,
				},
				products,
				skus,
				productAssets,
				productAssetLinks,
			),
		);
		await expect(duplicatePrimary).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("links asset rows to SKU targets and supports reordering", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const productAssets = new MemColl<StoredProductAsset>();
		const productAssetLinks = new MemColl<StoredProductAssetLink>();
		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "base",
			title: "Base",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await skus.put("sku_1", {
			id: "sku_1",
			productId: "prod_1",
			skuCode: "SKU-1",
			status: "active",
			unitPriceMinor: 1299,
			inventoryQuantity: 5,
			inventoryVersion: 1,
			requiresShipping: true,
			isDigital: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		for (let index = 0; index < 2; index++) {
			await productAssets.put(`asset_${index + 1}`, {
				id: `asset_${index + 1}`,
				provider: "media",
				externalAssetId: `media-${index + 1}`,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
		}

		const first = await linkCatalogAssetHandler(
			catalogCtx<ProductAssetLinkInput>(
				{
					assetId: "asset_1",
					targetType: "sku",
					targetId: "sku_1",
					role: "gallery_image",
					position: 0,
				},
				products,
				skus,
				productAssets,
				productAssetLinks,
			),
		);
		const second = await linkCatalogAssetHandler(
			catalogCtx<ProductAssetLinkInput>(
				{
					assetId: "asset_2",
					targetType: "sku",
					targetId: "sku_1",
					role: "gallery_image",
					position: 1,
				},
				products,
				skus,
				productAssets,
				productAssetLinks,
			),
		);

		const reordered = await reorderCatalogAssetHandler(
			catalogCtx<ProductAssetReorderInput>({ linkId: second.link.id, position: 0 }, products, skus, productAssets, productAssetLinks),
		);
		expect(reordered.link.position).toBe(0);

		const byTarget = await productAssetLinks.query({ where: { targetType: "sku", targetId: "sku_1" } });
		const inOrder = byTarget.items.map((item) => item.data).sort((left, right) => left.position - right.position);
		expect(inOrder[0]?.id).toBe(second.link.id);
		expect(inOrder[1]?.id).toBe(first.link.id);
	});

	it("unlinks an asset and removes its link row", async () => {
		const products = new MemColl<StoredProduct>();
		const productAssets = new MemColl<StoredProductAsset>();
		const productAssetLinks = new MemColl<StoredProductAssetLink>();
		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "base",
			title: "Base",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await productAssets.put("asset_1", {
			id: "asset_1",
			provider: "media",
			externalAssetId: "media-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const linked = await linkCatalogAssetHandler(
			catalogCtx<ProductAssetLinkInput>(
				{
					assetId: "asset_1",
					targetType: "product",
					targetId: "prod_1",
					role: "gallery_image",
				},
				products,
				new MemColl(),
				productAssets,
				productAssetLinks,
			),
		);

		const out = await unlinkCatalogAssetHandler(
			catalogCtx<ProductAssetUnlinkInput>(
				{
					linkId: linked.link.id,
				},
				products,
				new MemColl(),
				productAssets,
				productAssetLinks,
			),
		);
		expect(out.deleted).toBe(true);

		const removed = await productAssetLinks.get(linked.link.id);
		expect(removed).toBeNull();
	});
});
