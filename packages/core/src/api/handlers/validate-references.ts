import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { requestCached } from "../../request-cache.js";
import type { ApiResult } from "../types.js";

interface ReferenceFieldConstraints {
	slug: string;
	relation: string;
	multiple: boolean;
	required: boolean;
}

function validationError(message: string): ApiResult<never> {
	return { success: false, error: { code: "VALIDATION_ERROR", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function referenceFieldConstraints(
	db: Kysely<Database>,
	collection: string,
): Promise<Map<string, ReferenceFieldConstraints>> {
	return requestCached(`reference-field-constraints:${collection}`, async () => {
		const fields = await db
			.selectFrom("_emdash_fields")
			.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
			.select(["_emdash_fields.slug", "_emdash_fields.required", "_emdash_fields.validation"])
			.where("_emdash_collections.slug", "=", collection)
			.where("_emdash_fields.type", "=", "reference")
			.execute();

		const constraints = new Map<string, ReferenceFieldConstraints>();
		for (const field of fields) {
			if (!field.validation) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(field.validation);
			} catch {
				continue;
			}
			if (!isRecord(parsed) || typeof parsed.relation !== "string") continue;

			constraints.set(parsed.relation, {
				slug: field.slug,
				relation: parsed.relation,
				multiple: parsed.multiple === true,
				required: field.required === 1,
			});
		}
		return constraints;
	});
}

export function validateReferenceSelection(
	constraints: ReferenceFieldConstraints,
	childIds: string[],
): ApiResult<true> {
	if (!constraints.multiple && childIds.length > 1) {
		return validationError(
			`Field '${constraints.slug}' accepts a single reference, received ${childIds.length}.`,
		);
	}
	if (constraints.required && childIds.length === 0) {
		return validationError(
			`Field '${constraints.slug}' is required and must reference at least one entry.`,
		);
	}
	return { success: true, data: true };
}

export async function validateRequiredReferencesPresent(
	db: Kysely<Database>,
	collection: string,
	references: Record<string, string[]> | undefined,
	translationOf: string | undefined,
): Promise<ApiResult<true>> {
	// References belong to a translation group, so a new locale row inherits
	// the source group's existing edges when its payload omits them.
	if (translationOf) return { success: true, data: true };

	const constraints = await referenceFieldConstraints(db, collection);
	for (const field of constraints.values()) {
		if (!field.required) continue;
		if (references && Object.hasOwn(references, field.relation)) continue;
		return validationError(
			`Field '${field.slug}' is required and must reference at least one entry.`,
		);
	}
	return { success: true, data: true };
}
