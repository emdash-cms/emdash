import { PluginRouteError } from "emdash";

import type { StoredProductAttribute, StoredProductAttributeValue } from "../types.js";

export type SkuOptionAssignment = {
	attributeId: string;
	attributeValueId: string;
};

export type VariantDefiningAttribute = StoredProductAttribute & { kind: "variant_defining" };

export function normalizeSkuOptionSignature(options: readonly SkuOptionAssignment[]): string {
	return [...options]
		.map((row) => `${row.attributeId}:${row.attributeValueId}`)
		.sort()
		.join("|");
}

export function collectVariantDefiningAttributes(
	attributes: readonly StoredProductAttribute[],
): VariantDefiningAttribute[] {
	return attributes.filter((attribute): attribute is VariantDefiningAttribute =>
		attribute.kind === "variant_defining",
	);
}

function buildAllowedValuesByAttribute(
	attributeValues: readonly StoredProductAttributeValue[],
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const value of attributeValues) {
		const set = map.get(value.attributeId) ?? new Set<string>();
		set.add(value.id);
		map.set(value.attributeId, set);
	}
	return map;
}

export function validateVariableSkuOptions({
	productId,
	variantAttributes,
	attributeValues,
	optionValues,
	existingSignatures,
}: {
	productId: string;
	variantAttributes: readonly VariantDefiningAttribute[];
	attributeValues: readonly StoredProductAttributeValue[];
	optionValues: readonly SkuOptionAssignment[];
	existingSignatures: ReadonlySet<string>;
}) {
	const expectedAttributeIds = [...variantAttributes].map((attribute) => attribute.id);
	const expectedCount = expectedAttributeIds.length;
	if (optionValues.length !== expectedCount) {
		throw PluginRouteError.badRequest(
			`Product ${productId} requires exactly ${expectedCount} option values for variable SKUs`,
		);
	}

	const usedAttributeIds = new Set<string>();
	const seenValuePairs = new Set<string>();

	const allowedValuesByAttribute = buildAllowedValuesByAttribute(attributeValues);
	const expectedSet = new Set(expectedAttributeIds);

	for (const option of optionValues) {
		if (!expectedSet.has(option.attributeId)) {
			throw PluginRouteError.badRequest(`Option attribute ${option.attributeId} is not variant-defining`);
		}
		if (usedAttributeIds.has(option.attributeId)) {
			throw PluginRouteError.badRequest(`Duplicate option for attribute ${option.attributeId}`);
		}
		usedAttributeIds.add(option.attributeId);

		const allowedValues = allowedValuesByAttribute.get(option.attributeId);
		if (!allowedValues || !allowedValues.has(option.attributeValueId)) {
			throw PluginRouteError.badRequest(
				`Option value ${option.attributeValueId} is not defined for attribute ${option.attributeId}`,
			);
		}

		const pair = `${option.attributeId}:${option.attributeValueId}`;
		if (seenValuePairs.has(pair)) {
			throw PluginRouteError.badRequest(`Duplicate option assignment pair ${pair}`);
		}
		seenValuePairs.add(pair);
	}

	if (usedAttributeIds.size !== expectedAttributeIds.length) {
		throw PluginRouteError.badRequest(
			`Missing option values for product ${productId}: expected ${expectedAttributeIds.join(", ")}`,
		);
	}

	const signature = normalizeSkuOptionSignature(optionValues);
	if (existingSignatures.has(signature)) {
		throw PluginRouteError.badRequest(`Duplicate variant combination for product ${productId}`);
	}

	return signature;
}

