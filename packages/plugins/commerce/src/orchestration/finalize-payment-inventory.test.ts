import { describe, expect, it } from "vitest";

import type { OrderLineItem, StoredInventoryLedgerEntry, StoredInventoryStock } from "../types.js";
import { applyInventoryForOrder, inventoryStockDocId } from "./finalize-payment-inventory.js";

type MemOpts = { where?: Record<string, unknown>; limit?: number };

class MemColl<T extends object> {
	constructor(public readonly rows = new Map<string, T>()) {}

	async get(id: string): Promise<T | null> {
		const row = this.rows.get(id);
		return row ? structuredClone(row) : null;
	}

	async put(id: string, data: T): Promise<void> {
		this.rows.set(id, structuredClone(data));
	}

	async query(
		options: MemOpts = {},
	): Promise<{ items: Array<{ id: string; data: T }>; hasMore: boolean }> {
		const where = options.where ?? {};
		const limit = options.limit ?? 1000;
		let items = Array.from(this.rows.entries(), ([id, data]) => ({ id, data }));
		for (const [field, value] of Object.entries(where)) {
			items = items.filter((item) => (item.data as Record<string, unknown>)[field] === value);
		}
		return { items: items.slice(0, limit), hasMore: false };
	}
}

function bundleOrderLine(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
	const bundleProductId = "bundle_tx_1";
	const compProductId = "comp_prod_1";
	const compSkuId = "comp_sku_1";
	return {
		productId: bundleProductId,
		quantity: 2,
		inventoryVersion: 1,
		unitPriceMinor: 0,
		snapshot: {
			productId: bundleProductId,
			skuId: bundleProductId,
			productType: "bundle",
			productTitle: "Bundle",
			skuCode: bundleProductId,
			selectedOptions: [],
			currency: "USD",
			unitPriceMinor: 0,
			lineSubtotalMinor: 0,
			lineDiscountMinor: 0,
			lineTotalMinor: 0,
			requiresShipping: true,
			isDigital: false,
			bundleSummary: {
				productId: bundleProductId,
				subtotalMinor: 1000,
				discountType: "none",
				discountValueMinor: 0,
				discountValueBps: 0,
				discountAmountMinor: 0,
				finalPriceMinor: 1000,
				availability: 10,
				components: [
					{
						componentId: "bc_1",
						componentSkuId: compSkuId,
						componentSkuCode: "COMP-1",
						componentProductId: compProductId,
						componentPriceMinor: 500,
						quantityPerBundle: 3,
						subtotalContributionMinor: 1500,
						availableBundleQuantity: 10,
						componentInventoryVersion: 4,
					},
				],
			},
		},
		...overrides,
	};
}

describe("finalize-payment-inventory bundle expansion", () => {
	const now = "2026-04-10T12:00:00.000Z";

	it("decrements component SKU stock for bundle lines (no bundle-owned stock row)", async () => {
		const line = bundleOrderLine();
		const compProductId = "comp_prod_1";
		const compSkuId = "comp_sku_1";
		const stockId = inventoryStockDocId(compProductId, compSkuId);
		const inventoryStock = new MemColl<StoredInventoryStock>(
			new Map([
				[
					stockId,
					{
						productId: compProductId,
						variantId: compSkuId,
						version: 4,
						quantity: 100,
						updatedAt: now,
					},
				],
			]),
		);
		const inventoryLedger = new MemColl<StoredInventoryLedgerEntry>();

		await applyInventoryForOrder(
			{ inventoryStock, inventoryLedger },
			{ lineItems: [line] },
			"order_bundle_1",
			now,
		);

		const after = await inventoryStock.get(stockId);
		// 2 bundles × 3 units per bundle = 6
		expect(after?.quantity).toBe(94);
		expect(after?.version).toBe(5);
	});

	it("legacy bundle snapshot without valid component versions still uses bundle product stock row", async () => {
		const bundleProductId = "bundle_legacy_1";
		const line: OrderLineItem = {
			productId: bundleProductId,
			quantity: 1,
			inventoryVersion: 2,
			unitPriceMinor: 100,
			snapshot: {
				productId: bundleProductId,
				skuId: bundleProductId,
				productType: "bundle",
				productTitle: "Legacy",
				skuCode: bundleProductId,
				selectedOptions: [],
				currency: "USD",
				unitPriceMinor: 100,
				lineSubtotalMinor: 100,
				lineDiscountMinor: 0,
				lineTotalMinor: 100,
				requiresShipping: true,
				isDigital: false,
				bundleSummary: {
					productId: bundleProductId,
					subtotalMinor: 100,
					discountType: "none",
					discountValueMinor: 0,
					discountValueBps: 0,
					discountAmountMinor: 0,
					finalPriceMinor: 100,
					availability: 1,
					components: [
						{
							componentId: "c1",
							componentSkuId: "sku_x",
							componentSkuCode: "X",
							componentProductId: "p_x",
							componentPriceMinor: 100,
							quantityPerBundle: 1,
							subtotalContributionMinor: 100,
							availableBundleQuantity: 1,
							componentInventoryVersion: -1,
						},
					],
				},
			},
		};
		const stockId = inventoryStockDocId(bundleProductId, "");
		const inventoryStock = new MemColl<StoredInventoryStock>(
			new Map([
				[
					stockId,
					{
						productId: bundleProductId,
						variantId: "",
						version: 2,
						quantity: 5,
						updatedAt: now,
					},
				],
			]),
		);
		const inventoryLedger = new MemColl<StoredInventoryLedgerEntry>();

		await applyInventoryForOrder(
			{ inventoryStock, inventoryLedger },
			{ lineItems: [line] },
			"order_legacy_bundle",
			now,
		);

		const after = await inventoryStock.get(stockId);
		expect(after?.quantity).toBe(4);
	});

	it("throws PRODUCT_UNAVAILABLE when authoritative stock row is missing", async () => {
		const line: OrderLineItem = {
			productId: "simple_legacy_1",
			quantity: 1,
			inventoryVersion: 3,
			unitPriceMinor: 500,
			snapshot: {
				productId: "simple_legacy_1",
				skuId: "simple_legacy_1",
				productType: "simple",
				productTitle: "Simple Legacy",
				skuCode: "SIMPLE-LEGACY",
				selectedOptions: [],
				currency: "USD",
			unitPriceMinor: 500,
				lineSubtotalMinor: 500,
				lineDiscountMinor: 0,
				lineTotalMinor: 500,
				requiresShipping: true,
				isDigital: false,
			},
		};
	const missingStockNow = "2026-04-10T12:00:00.000Z";
	const inventoryStock = new MemColl<StoredInventoryStock>(
		new Map([
			[
				inventoryStockDocId("simple_legacy_1", "legacy_sku"),
				{
					productId: "simple_legacy_1",
					variantId: "legacy_sku",
					version: 3,
					quantity: 3,
					updatedAt: missingStockNow,
				},
			],
		]),
	);
		const inventoryLedger = new MemColl<StoredInventoryLedgerEntry>();

	await expect(applyInventoryForOrder({ inventoryStock, inventoryLedger }, { lineItems: [line] }, "legacy-order", missingStockNow)).rejects.toMatchObject({
			code: "PRODUCT_UNAVAILABLE",
		});
		expect(inventoryLedger.rows.size).toBe(0);
	});
});
