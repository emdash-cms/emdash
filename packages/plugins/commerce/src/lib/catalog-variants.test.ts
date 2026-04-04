import { describe, expect, it } from "vitest";

import { collectVariantDefiningAttributes, validateVariableSkuOptions } from "./catalog-variants.js";

import type { StoredProductAttribute, StoredProductAttributeValue } from "../types.js";

describe("catalog variant invariants", () => {
	const colorAttribute: StoredProductAttribute = {
		id: "attr_color",
		productId: "prod_1",
		name: "Color",
		code: "color",
		kind: "variant_defining",
		position: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const sizeAttribute: StoredProductAttribute = {
		id: "attr_size",
		productId: "prod_1",
		name: "Size",
		code: "size",
		kind: "variant_defining",
		position: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const labelAttribute: StoredProductAttribute = {
		id: "attr_label",
		productId: "prod_1",
		name: "Label",
		code: "label",
		kind: "descriptive",
		position: 2,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};

	const valueColorRed: StoredProductAttributeValue = {
		id: "val_red",
		attributeId: "attr_color",
		value: "Red",
		code: "red",
		position: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const valueColorBlue: StoredProductAttributeValue = {
		id: "val_blue",
		attributeId: "attr_color",
		value: "Blue",
		code: "blue",
		position: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const valueSizeS: StoredProductAttributeValue = {
		id: "val_s",
		attributeId: "attr_size",
		value: "Small",
		code: "s",
		position: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	it("filters variant-defining attributes", () => {
		const selected = collectVariantDefiningAttributes([
			colorAttribute,
			sizeAttribute,
			labelAttribute,
		]);
		expect(selected.map((row) => row.code)).toEqual(["color", "size"]);
	});

	it("rejects SKU options missing or extra variant-defining assignments", () => {
		const variantAttributes = [colorAttribute, sizeAttribute];
		const attributeValues = [valueColorRed, valueColorBlue, valueSizeS];
		expect(() =>
			validateVariableSkuOptions({
				productId: "prod_1",
				variantAttributes,
				attributeValues,
				optionValues: [{ attributeId: colorAttribute.id, attributeValueId: valueColorRed.id }],
				existingSignatures: new Set(),
			}),
		).toThrowError();
		expect(() =>
			validateVariableSkuOptions({
				productId: "prod_1",
				variantAttributes,
				attributeValues,
				optionValues: [
					{ attributeId: colorAttribute.id, attributeValueId: valueColorRed.id },
					{ attributeId: sizeAttribute.id, attributeValueId: valueSizeS.id },
					{ attributeId: colorAttribute.id, attributeValueId: valueColorBlue.id },
				],
				existingSignatures: new Set(),
			}),
		).toThrowError();
	});

	it("rejects unknown and duplicate option pair definitions", () => {
		const variantAttributes = [colorAttribute, sizeAttribute];
		const attributeValues = [valueColorRed, valueSizeS];
		expect(() =>
			validateVariableSkuOptions({
				productId: "prod_1",
				variantAttributes,
				attributeValues,
				optionValues: [
					{ attributeId: colorAttribute.id, attributeValueId: valueColorRed.id },
					{ attributeId: sizeAttribute.id, attributeValueId: "missing_value" },
				],
				existingSignatures: new Set(),
			}),
		).toThrowError();

		expect(() =>
			validateVariableSkuOptions({
				productId: "prod_1",
				variantAttributes,
				attributeValues,
				optionValues: [
					{ attributeId: colorAttribute.id, attributeValueId: valueColorRed.id },
					{ attributeId: colorAttribute.id, attributeValueId: valueColorBlue.id },
				],
				existingSignatures: new Set(),
			}),
		).toThrowError();
	});

	it("rejects duplicate option combinations across SKUs", () => {
		const variantAttributes = [colorAttribute];
		const attributeValues = [valueColorRed, valueColorBlue];
		expect(() =>
			validateVariableSkuOptions({
				productId: "prod_1",
				variantAttributes,
				attributeValues,
				optionValues: [{ attributeId: colorAttribute.id, attributeValueId: valueColorRed.id }],
				existingSignatures: new Set([`${colorAttribute.id}:${valueColorRed.id}`]),
			}),
		).toThrowError();
	});
});
