import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import type {
	StoredProduct,
	StoredProductAsset,
	StoredProductAssetLink,
	StoredProductAttribute,
	StoredProductAttributeValue,
	StoredDigitalAsset,
	StoredDigitalEntitlement,
	StoredProductSku,
	StoredProductSkuOptionValue,
} from "../types.js";
import type {
	ProductAssetLinkInput,
	ProductAssetReorderInput,
	ProductAssetRegisterInput,
	ProductAssetUnlinkInput,
	ProductSkuCreateInput,
	ProductCreateInput,
	DigitalAssetCreateInput,
	DigitalEntitlementCreateInput,
} from "../schemas.js";
import {
	productAssetLinkInputSchema,
	productAssetReorderInputSchema,
	productAssetRegisterInputSchema,
	productAssetUnlinkInputSchema,
	digitalAssetCreateInputSchema,
	digitalEntitlementCreateInputSchema,
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
	createDigitalAssetHandler,
	createDigitalEntitlementHandler,
	removeDigitalEntitlementHandler,
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
	productAttributes = new MemColl<StoredProductAttribute>(),
	productAttributeValues = new MemColl<StoredProductAttributeValue>(),
	productSkuOptionValues = new MemColl<StoredProductSkuOptionValue>(),
	digitalAssets = new MemColl<StoredDigitalAsset>(),
	digitalEntitlements = new MemColl<StoredDigitalEntitlement>(),
): RouteContext<TInput> {
	return {
		request: new Request("https://example.test/catalog", { method: "POST" }),
		input,
		storage: {
			products,
			productSkus,
			productAssets,
			productAssetLinks,
			productAttributes,
			productAttributeValues,
			productSkuOptionValues,
			digitalAssets,
			digitalEntitlements,
		},
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

	it("creates variable products with variant attributes and values", async () => {
		const products = new MemColl<StoredProduct>();
		const productAttributes = new MemColl<StoredProductAttribute>();
		const productAttributeValues = new MemColl<StoredProductAttributeValue>();

		const out = await createProductHandler(
			catalogCtx<ProductCreateInput>(
				{
					type: "variable",
					status: "draft",
					visibility: "hidden",
					slug: "tee-shirt",
					title: "Tee Shirt",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
					attributes: [
						{
							name: "Color",
							code: "color",
							kind: "variant_defining",
							position: 0,
							values: [
								{ value: "Red", code: "red", position: 0 },
								{ value: "Blue", code: "blue", position: 1 },
							],
						},
						{
							name: "Size",
							code: "size",
							kind: "variant_defining",
							position: 1,
							values: [
								{ value: "Small", code: "s", position: 0 },
								{ value: "Large", code: "l", position: 1 },
							],
						},
					],
				},
				products,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
			),
		);

		expect(out.product.type).toBe("variable");
		expect(productAttributes.rows.size).toBe(2);
		expect(productAttributeValues.rows.size).toBe(4);
	});

	it("rejects variable products without variant-defining attributes", async () => {
		const products = new MemColl<StoredProduct>();
		const out = createProductHandler(
			catalogCtx<ProductCreateInput>(
				{
					type: "variable",
					status: "draft",
					visibility: "hidden",
					slug: "bad-variable",
					title: "Bad Variable",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
					attributes: [
						{
							name: "Material",
							code: "material",
							kind: "descriptive",
							position: 0,
							values: [{ value: "Cotton", code: "cotton", position: 0 }],
						},
					],
				},
				products,
			),
		);
		await expect(out).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects variable products with duplicate attribute codes", async () => {
		const products = new MemColl<StoredProduct>();
		const out = createProductHandler(
			catalogCtx<ProductCreateInput>(
				{
					type: "variable",
					status: "draft",
					visibility: "hidden",
					slug: "dup-attr",
					title: "Dup Attr",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
					attributes: [
						{
							name: "Color",
							code: "color",
							kind: "variant_defining",
							position: 0,
							values: [{ value: "Red", code: "red", position: 0 }],
						},
						{
							name: "Color Alt",
							code: "color",
							kind: "variant_defining",
							position: 1,
							values: [{ value: "Blue", code: "blue", position: 0 }],
						},
					],
				},
				products,
			),
		);
		await expect(out).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects duplicate value codes within a variable attribute", async () => {
		const products = new MemColl<StoredProduct>();
		const out = createProductHandler(
			catalogCtx<ProductCreateInput>(
				{
					type: "variable",
					status: "draft",
					visibility: "hidden",
					slug: "dup-value",
					title: "Dup Value",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
					attributes: [
						{
							name: "Color",
							code: "color",
							kind: "variant_defining",
							position: 0,
							values: [
								{ value: "Red", code: "red", position: 0 },
								{ value: "Maroon", code: "red", position: 1 },
							],
						},
					],
				},
				products,
			),
		);
		await expect(out).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

	it("returns entitlement summaries in product detail view", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const digitalAssets = new MemColl<StoredDigitalAsset>();
		const digitalEntitlements = new MemColl<StoredDigitalEntitlement>();

		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "digital-product",
			title: "Digital Product",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await skus.put("sku_1", {
			id: "sku_1",
			productId: "prod_1",
			skuCode: "DIGI",
			status: "active",
			unitPriceMinor: 199,
			inventoryQuantity: 100,
			inventoryVersion: 1,
			requiresShipping: false,
			isDigital: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const asset = await createDigitalAssetHandler(
			catalogCtx<DigitalAssetCreateInput>(
				{
					externalAssetId: "media-101",
					provider: "media",
					label: "Product Manual",
					downloadLimit: 1,
					downloadExpiryDays: 30,
					isManualOnly: true,
					isPrivate: true,
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				digitalAssets,
				digitalEntitlements,
			),
		);

		await createDigitalEntitlementHandler(
			catalogCtx<DigitalEntitlementCreateInput>(
				{
					skuId: "sku_1",
					digitalAssetId: asset.asset.id,
					grantedQuantity: 2,
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				digitalAssets,
				digitalEntitlements,
			),
		);

		const out = await getProductHandler(
			catalogCtx(
				{ productId: "prod_1" },
				products,
				skus,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				digitalAssets,
				digitalEntitlements,
			),
		);

		expect(out.digitalEntitlements).toEqual([
			{
				skuId: "sku_1",
				entitlements: [
					{
						entitlementId: expect.any(String),
						digitalAssetId: asset.asset.id,
						digitalAssetLabel: "Product Manual",
						grantedQuantity: 2,
						downloadLimit: 1,
						downloadExpiryDays: 30,
						isManualOnly: true,
						isPrivate: true,
					},
				],
			},
		]);
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

	it("stores variant option mappings and returns a variable matrix on get", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const productAttributes = new MemColl<StoredProductAttribute>();
		const productAttributeValues = new MemColl<StoredProductAttributeValue>();
		const productSkuOptionValues = new MemColl<StoredProductSkuOptionValue>();

		const product = await createProductHandler(
			catalogCtx<ProductCreateInput>(
				{
					type: "variable",
					status: "active",
					visibility: "public",
					slug: "variable-shirt",
					title: "Variable Shirt",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
					attributes: [
						{
							name: "Color",
							code: "color",
							kind: "variant_defining",
							position: 0,
							values: [
								{ value: "Red", code: "red", position: 0 },
								{ value: "Blue", code: "blue", position: 1 },
							],
						},
						{
							name: "Size",
							code: "size",
							kind: "variant_defining",
							position: 1,
							values: [
								{ value: "Small", code: "s", position: 0 },
								{ value: "Large", code: "l", position: 1 },
							],
						},
					],
				},
				products,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
			),
		);

		const colorAttribute = [...productAttributes.rows.values()].find((attribute) => attribute.code === "color");
		expect(colorAttribute).toBeDefined();
		const sizeAttribute = [...productAttributes.rows.values()].find((attribute) => attribute.code === "size");
		expect(sizeAttribute).toBeDefined();
		const valueByCode = new Map([...productAttributeValues.rows.values()].map((row) => [row.code, row.id]));

		const skuA = await createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: product.product.id,
					skuCode: "VSHIRT-RS",
					status: "active",
					unitPriceMinor: 2100,
					inventoryQuantity: 15,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
					optionValues: [
						{
							attributeId: colorAttribute!.id,
							attributeValueId: valueByCode.get("red")!,
						},
						{
							attributeId: sizeAttribute!.id,
							attributeValueId: valueByCode.get("s")!,
						},
					],
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
				productSkuOptionValues,
			),
		);

		const skuB = await createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: product.product.id,
					skuCode: "VSHIRT-BL",
					status: "active",
					unitPriceMinor: 2200,
					inventoryQuantity: 10,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
					optionValues: [
						{
							attributeId: colorAttribute!.id,
							attributeValueId: valueByCode.get("blue")!,
						},
						{
							attributeId: sizeAttribute!.id,
							attributeValueId: valueByCode.get("l")!,
						},
					],
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
				productSkuOptionValues,
			),
		);

		expect(skuA.sku.skuCode).toBe("VSHIRT-RS");
		expect(skuB.sku.skuCode).toBe("VSHIRT-BL");
		expect(productSkuOptionValues.rows.size).toBe(4);

		const detail = await getProductHandler(
			catalogCtx(
				{ productId: product.product.id },
				products,
				skus,
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
				productSkuOptionValues,
			),
		);
		expect(detail.attributes).toHaveLength(2);
		expect(detail.variantMatrix).toHaveLength(2);
		expect(detail.variantMatrix?.every((row) => row.options.length === 2)).toBe(true);
	});

	it("rejects variable SKU creation when option coverage is incomplete", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const productAttributes = new MemColl<StoredProductAttribute>();
		const productAttributeValues = new MemColl<StoredProductAttributeValue>();
		const productSkuOptionValues = new MemColl<StoredProductSkuOptionValue>();

		const product = await createProductHandler(
			catalogCtx<ProductCreateInput>(
				{
					type: "variable",
					status: "active",
					visibility: "public",
					slug: "incomplete-variable",
					title: "Incomplete variable",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
					attributes: [
						{
							name: "Color",
							code: "color",
							kind: "variant_defining",
							position: 0,
							values: [
								{ value: "Red", code: "red", position: 0 },
								{ value: "Blue", code: "blue", position: 1 },
							],
						},
						{
							name: "Size",
							code: "size",
							kind: "variant_defining",
							position: 1,
							values: [{ value: "Small", code: "s", position: 0 }],
						},
					],
				},
				products,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
			),
		);

		const missing = createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: product.product.id,
					skuCode: "MISS-1",
					status: "active",
					unitPriceMinor: 1000,
					inventoryQuantity: 1,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
					optionValues: [
						{
							attributeId: [...productAttributes.rows.values()][0]!.id,
							attributeValueId: [...productAttributeValues.rows.values()][0]!.id,
						},
					],
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
				productSkuOptionValues,
			),
		);
		await expect(missing).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects option mappings on non-variable products", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		await products.put("parent", {
			id: "parent",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "simple-parent",
			title: "Simple Parent",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const out = createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: "parent",
					skuCode: "BAD-MAP",
					status: "active",
					unitPriceMinor: 1000,
					inventoryQuantity: 1,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
					optionValues: [{ attributeId: "attr_1", attributeValueId: "val_1" }],
				},
				products,
				skus,
			),
		);

		await expect(out).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects duplicate and duplicate-combination SKU option mappings for variable products", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const productAttributes = new MemColl<StoredProductAttribute>();
		const productAttributeValues = new MemColl<StoredProductAttributeValue>();
		const productSkuOptionValues = new MemColl<StoredProductSkuOptionValue>();

		const product = await createProductHandler(
			catalogCtx<ProductCreateInput>(
				{
					type: "variable",
					status: "active",
					visibility: "public",
					slug: "combo-variable",
					title: "Combo variable",
					shortDescription: "",
					longDescription: "",
					featured: false,
					sortOrder: 0,
					requiresShippingDefault: true,
					attributes: [
						{
							name: "Color",
							code: "color",
							kind: "variant_defining",
							position: 0,
							values: [{ value: "Red", code: "red", position: 0 }],
						},
					],
				},
				products,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
			),
		);

		const colorAttribute = [...productAttributes.rows.values()][0]!;
		const colorValue = [...productAttributeValues.rows.values()][0]!;

		const duplicateAttributeValue = createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: product.product.id,
					skuCode: "DUP-1",
					status: "active",
					unitPriceMinor: 1000,
					inventoryQuantity: 1,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
					optionValues: [
						{ attributeId: colorAttribute.id, attributeValueId: colorValue.id },
						{ attributeId: colorAttribute.id, attributeValueId: colorValue.id },
					],
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
				productSkuOptionValues,
			),
		);
		await expect(duplicateAttributeValue).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: product.product.id,
					skuCode: "V1",
					status: "active",
					unitPriceMinor: 1100,
					inventoryQuantity: 2,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
					optionValues: [{ attributeId: colorAttribute.id, attributeValueId: colorValue.id }],
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
				productSkuOptionValues,
			),
		);

		const duplicateCombination = createProductSkuHandler(
			catalogCtx<ProductSkuCreateInput>(
				{
					productId: product.product.id,
					skuCode: "V2",
					status: "active",
					unitPriceMinor: 1150,
					inventoryQuantity: 2,
					inventoryVersion: 1,
					requiresShipping: true,
					isDigital: false,
					optionValues: [{ attributeId: colorAttribute.id, attributeValueId: colorValue.id }],
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				productAttributes,
				productAttributeValues,
				productSkuOptionValues,
			),
		);
		await expect(duplicateCombination).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

describe("catalog digital entitlement handlers", () => {
	it("rejects binary-upload payload keys at the contract boundary", () => {
		expect(
			digitalAssetCreateInputSchema.safeParse({
				externalAssetId: "media-1",
				provider: "media",
				file: "should-not-be-uploaded",
			}).success,
		).toBe(false);
		expect(
			digitalEntitlementCreateInputSchema.safeParse({
				skuId: "sku_1",
				digitalAssetId: "asset_1",
				grantedQuantity: 1,
				file: "should-not-be-uploaded",
			}).success,
		).toBe(false);
	});

	it("creates digital assets and entitlements, and enforces unique mapping per SKU+asset", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const digitalAssets = new MemColl<StoredDigitalAsset>();
		const digitalEntitlements = new MemColl<StoredDigitalEntitlement>();

		await products.put("prod_1", {
			id: "prod_1",
			type: "simple",
			status: "active",
			visibility: "public",
			slug: "digital-product",
			title: "Digital Product",
			shortDescription: "",
			longDescription: "",
			featured: false,
			sortOrder: 0,
			requiresShippingDefault: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await skus.put("sku_1", {
			id: "sku_1",
			productId: "prod_1",
			skuCode: "DIGI",
			status: "active",
			unitPriceMinor: 199,
			inventoryQuantity: 100,
			inventoryVersion: 1,
			requiresShipping: false,
			isDigital: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const asset = await createDigitalAssetHandler(
			catalogCtx<DigitalAssetCreateInput>(
				{
					externalAssetId: "media-101",
					provider: "media",
					label: "Product Manual",
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				digitalAssets,
				digitalEntitlements,
			),
		);

		const first = await createDigitalEntitlementHandler(
			catalogCtx<DigitalEntitlementCreateInput>(
				{
					skuId: "sku_1",
					digitalAssetId: asset.asset.id,
					grantedQuantity: 1,
				},
				products,
				skus,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				digitalAssets,
				digitalEntitlements,
			),
		);
		expect(first.entitlement.skuId).toBe("sku_1");
		expect(first.entitlement.digitalAssetId).toBe(asset.asset.id);
		await expect(
			createDigitalEntitlementHandler(
				catalogCtx<DigitalEntitlementCreateInput>(
					{
						skuId: "sku_1",
						digitalAssetId: asset.asset.id,
						grantedQuantity: 1,
					},
					products,
					skus,
					new MemColl(),
					new MemColl(),
					new MemColl(),
					new MemColl(),
					new MemColl(),
					digitalAssets,
					digitalEntitlements,
				),
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("removes entitlement assignments", async () => {
		const products = new MemColl<StoredProduct>();
		const skus = new MemColl<StoredProductSku>();
		const digitalAssets = new MemColl<StoredDigitalAsset>();
		const digitalEntitlements = new MemColl<StoredDigitalEntitlement>();

		await digitalEntitlements.put("ent_1", {
			id: "ent_1",
			skuId: "sku_1",
			digitalAssetId: "asset_1",
			grantedQuantity: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		const out = await removeDigitalEntitlementHandler(
			catalogCtx(
				{ entitlementId: "ent_1" },
				products,
				skus,
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				new MemColl(),
				digitalAssets,
				digitalEntitlements,
			),
		);
		expect(out.deleted).toBe(true);

		const missing = await digitalEntitlements.get("ent_1");
		expect(missing).toBeNull();
	});
});
