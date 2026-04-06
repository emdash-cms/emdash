import { describe, expect, it } from "vitest";

import { computeBundleSummary } from "./catalog-bundles.js";

const skuA = {
	id: "sku_1",
	productId: "prod_bundle",
	skuCode: "B-A",
	status: "active",
	unitPriceMinor: 200,
	inventoryQuantity: 12,
	inventoryVersion: 1,
	requiresShipping: true,
	isDigital: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const skuB = {
	id: "sku_2",
	productId: "prod_parent",
	skuCode: "B-B",
	status: "active",
	unitPriceMinor: 50,
	inventoryQuantity: 3,
	inventoryVersion: 1,
	requiresShipping: true,
	isDigital: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("bundle discount summary", () => {
	it("computes fixed-discount availability and final price", () => {
		const out = computeBundleSummary("bundle_1", "fixed_amount", 180, undefined, [
			{
				component: {
					id: "c1",
					bundleProductId: "bundle_1",
					componentSkuId: "sku_1",
					quantity: 2,
					position: 0,
					createdAt: "2026",
					updatedAt: "2026",
				},
				sku: skuA,
			},
			{
				component: {
					id: "c2",
					bundleProductId: "bundle_1",
					componentSkuId: "sku_2",
					quantity: 1,
					position: 1,
					createdAt: "2026",
					updatedAt: "2026",
				},
				sku: skuB,
			},
		]);
		expect(out.subtotalMinor).toBe(450);
		expect(out.discountAmountMinor).toBe(180);
		expect(out.finalPriceMinor).toBe(270);
		expect(out.availability).toBe(3);
		expect(out.components[0]!.availableBundleQuantity).toBe(6);
		expect(out.components[1]!.availableBundleQuantity).toBe(3);
	});

	it("computes percentage discounts with floor behavior", () => {
		const out = computeBundleSummary("bundle_1", "percentage", undefined, 2_000, [
			{
				component: {
					id: "c1",
					bundleProductId: "bundle_1",
					componentSkuId: "sku_1",
					quantity: 2,
					position: 0,
					createdAt: "2026",
					updatedAt: "2026",
				},
				sku: skuA,
			},
		]);
		expect(out.subtotalMinor).toBe(400);
		expect(out.discountAmountMinor).toBe(80);
		expect(out.finalPriceMinor).toBe(320);
	});

	it("sets availability to zero when any component is inactive", () => {
		const out = computeBundleSummary("bundle_1", "none", undefined, undefined, [
			{
				component: {
					id: "c1",
					bundleProductId: "bundle_1",
					componentSkuId: "sku_1",
					quantity: 2,
					position: 0,
					createdAt: "2026",
					updatedAt: "2026",
				},
				sku: skuA,
			},
			{
				component: {
					id: "c2",
					bundleProductId: "bundle_1",
					componentSkuId: "sku_2",
					quantity: 1,
					position: 1,
					createdAt: "2026",
					updatedAt: "2026",
				},
				sku: { ...skuB, status: "inactive" },
			},
		]);
		expect(out.availability).toBe(0);
		expect(out.components[1]!.availableBundleQuantity).toBe(0);
	});
});
