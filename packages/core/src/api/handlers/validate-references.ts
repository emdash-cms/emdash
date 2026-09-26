import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { requestCached } from "../../request-cache.js";
import type { ApiResult } from "../types.js";

export interface ReferenceFieldConstraints {
	/** Field slug — how the entry API addresses the selection. */
	slug: string;
	/** Relation slug the field binds to. */
	relation: string;
	/** Relation id, for the reads that address the link table directly. */
	relationId: string | null;
	/** Which end of the relation the field's own collection sits on. */
	relationSide: "parent" | "child";
	/** How many entries this side of the relation may hold. `null` is unlimited. */
	maxSelected: number | null;
	/** How many this field's selection may hand each entry it selects. */
	maxOpposite: number | null;
	required: boolean;
}

function validationError(message: string): ApiResult<never> {
	return { success: false, error: { code: "VALIDATION_ERROR", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Every reference field on a collection that is bound to a relation, by field
 * slug — the key the entry API takes a selection under.
 */
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

		// Cardinality lives on the relation, not the field: with both ends of a
		// relation bindable, two fields carrying their own limits could disagree
		// about one edge set. The field contributes only which end it views.
		const relations = await db
			.selectFrom("_emdash_relations")
			.select(["id", "slug", "max_children_per_parent", "max_parents_per_child"])
			.execute();
		const limits = new Map(relations.map((r) => [r.slug, r]));

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

			const relation = limits.get(parsed.relation);
			const relationSide = parsed.relationSide === "child" ? "child" : "parent";
			const onChildSide = relationSide === "child";

			constraints.set(field.slug, {
				slug: field.slug,
				relation: parsed.relation,
				relationId: relation?.id ?? null,
				relationSide,
				maxSelected: onChildSide
					? (relation?.max_parents_per_child ?? null)
					: (relation?.max_children_per_parent ?? null),
				maxOpposite: onChildSide
					? (relation?.max_children_per_parent ?? null)
					: (relation?.max_parents_per_child ?? null),
				required: field.required === 1,
			});
		}
		return constraints;
	});
}

/**
 * The field viewing one end of a relation, for the relation-scoped routes, which
 * address a relation rather than a field. At most one field binds each
 * (relation, side), so this is unambiguous.
 */
export function constraintsForRelationSide(
	constraints: Map<string, ReferenceFieldConstraints>,
	relation: string,
	side: "parent" | "child",
): ReferenceFieldConstraints | undefined {
	for (const field of constraints.values()) {
		if (field.relation === relation && field.relationSide === side) return field;
	}
	return undefined;
}

export function validateReferenceSelection(
	constraints: ReferenceFieldConstraints,
	childIds: string[],
): ApiResult<true> {
	const max = constraints.maxSelected;
	if (max !== null && childIds.length > max) {
		return validationError(
			max === 1
				? `Field '${constraints.slug}' accepts a single reference, received ${childIds.length}.`
				: `Field '${constraints.slug}' accepts at most ${max} references, received ${childIds.length}.`,
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
		if (references && Object.hasOwn(references, field.slug)) continue;
		return validationError(
			`Field '${field.slug}' is required and must reference at least one entry.`,
		);
	}
	return { success: true, data: true };
}
