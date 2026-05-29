import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";

import { withTransaction } from "../database/transaction.js";
import type { BylineFieldTable, Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import {
	BYLINE_FIELD_TYPES,
	RESERVED_BYLINE_FIELD_SLUGS,
	type BylineFieldDefinition,
	type BylineFieldType,
	type BylineFieldValidation,
	type CreateBylineFieldInput,
	type UpdateBylineFieldInput,
} from "./types.js";

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_BYLINE_FIELD_SLUGS);
const TYPE_SET: ReadonlySet<string> = new Set(BYLINE_FIELD_TYPES);

const VERSION_KEY = "byline_fields_version";

/** Hard cap on the choices array for a `select`-type field. */
const MAX_SELECT_OPTIONS = 200;
/** Hard cap on a slug — mirrors `SchemaRegistry.validateSlug`. */
const MAX_SLUG_LENGTH = 63;
/** Hard cap on a label. Bigger than slugs because labels are display strings. */
const MAX_LABEL_LENGTH = 200;

/**
 * Error thrown for byline-schema validation failures. Mirrors
 * `SchemaError` in `registry.ts` so the admin API layer can map a small
 * set of codes to HTTP statuses without inspecting messages.
 *
 * Codes:
 * - `INVALID_SLUG`      — slug fails identifier rules or length cap
 * - `RESERVED_SLUG`     — slug collides with a fixed `_emdash_bylines` column
 * - `INVALID_TYPE`      — type is not one of the five v1 field types
 * - `INVALID_LABEL`     — label missing or exceeds length cap
 * - `INVALID_VALIDATION` — validation payload malformed (e.g. `select` with
 *                          no `options`, duplicates in `options`)
 * - `FIELD_EXISTS`      — slug already registered
 * - `FIELD_NOT_FOUND`   — slug not registered
 * - `TRANSLATABLE_LOCKED` — attempt to flip `translatable` while stored
 *                          values reference the field
 * - `REORDER_MISMATCH`  — reorder input doesn't match the registered set
 */
export class BylineSchemaError extends Error {
	constructor(
		message: string,
		public code: string,
		public details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "BylineSchemaError";
	}
}

/**
 * Translate a `BylineSchemaError` code to a shared `ErrorCode` for the
 * admin API. HTTP status is then derived by `mapErrorStatus` — this
 * function deliberately doesn't carry one, so the API/handler boundary
 * matches the rest of the codebase (handlers return `ApiResult<T>` with
 * a code, the route layer maps to status via `unwrapResult`).
 *
 * Every code on the right-hand side of `case ... return ...` is defined
 * in `ErrorCode` (`api/errors.ts`). `INVALID_LABEL` and
 * `INVALID_VALIDATION` are intentionally folded into the `default`
 * branch (→ `VALIDATION_ERROR`) so no ad-hoc codes leak out — the
 * registry's domain code names them but the HTTP surface should not.
 *
 * `RESERVED_SLUG` / `INVALID_SLUG` typically don't reach this layer for
 * HTTP callers — the zod schema rejects them first with a clean
 * `VALIDATION_ERROR`. They're still listed so non-HTTP callers (and the
 * test layer) get consistent mapping.
 *
 * `FIELD_NOT_FOUND` is normalised to the shared `NOT_FOUND` code so the
 * admin client can branch on one constant across resource types.
 */
export function mapBylineSchemaError(error: BylineSchemaError): {
	code: string;
	message: string;
	details?: Record<string, unknown>;
} {
	switch (error.code) {
		case "FIELD_NOT_FOUND":
			return { code: "NOT_FOUND", message: error.message, details: error.details };
		case "FIELD_EXISTS":
		case "TRANSLATABLE_LOCKED":
		case "REORDER_MISMATCH":
		case "INVALID_SLUG":
		case "RESERVED_SLUG":
		case "INVALID_TYPE":
			return { code: error.code, message: error.message, details: error.details };
		default:
			// Catches INVALID_LABEL, INVALID_VALIDATION, and any future
			// registry codes we forget to wire up explicitly.
			return { code: "VALIDATION_ERROR", message: error.message, details: error.details };
	}
}

/**
 * Registry for byline custom fields (Discussion #1174).
 *
 * Owns CRUD over `_emdash_byline_fields` and the
 * `options.byline_fields_version` counter that drives cache
 * invalidation in `bylines/field-defs-cache.ts`.
 *
 * **Dirty-bit bookend.** Every mutation runs `markVersionDirty` before
 * the schema write and `markVersionClean` after, as standalone writes
 * (not inside `withTransaction`) so concurrent isolates observe the
 * dirty mark *before* the mutation lands. Parity carries meaning:
 * odd = mutation in flight or crashed mid-flight, even = stable.
 * The cache bypasses the global holder while odd.
 *
 * `markVersionDirty` is parity-aware (idempotent on odd) so a
 * crashed prior attempt doesn't invert the bit.
 * `markVersionClean` always advances to a new even value (+2 from
 * even, +1 from odd) so concurrent mutators can't collapse on the
 * same key and pin a stale cache snapshot. Idempotent-retry exits
 * (`FIELD_EXISTS` / `FIELD_NOT_FOUND` / no-op update) call
 * `markVersionClean` too — same code path doubles as crash recovery
 * and false-clean recovery.
 *
 * The residual race: a reader caching between two concurrent
 * `markVersionClean` calls sees a partial-set snapshot until the
 * second clean lands. Bounded by the inter-clean window (~ms).
 * Schema mutations are admin-only and rare; acceptable for now.
 * A CAS-on-bump or dialect-specific lock is tracked as follow-up.
 *
 * **`deleteField` cascade.** Migration 041 already declares
 * `ON DELETE CASCADE` on both value tables. The explicit deletes
 * here are defense-in-depth against FK-pragma misconfig and mirror
 * `BylineRepository.delete`'s app-level cascade for the bylines
 * domain.
 *
 * Reserved-slug rejection runs at the API layer (zod) *and* here so
 * non-HTTP callers (seeds, scripts) can't bypass the check.
 */
export class BylineSchemaRegistry {
	constructor(private db: Kysely<Database>) {}

	async listFields(): Promise<BylineFieldDefinition[]> {
		const rows = await this.db
			.selectFrom("_emdash_byline_fields")
			.selectAll()
			.orderBy("sort_order", "asc")
			.orderBy("created_at", "asc")
			.execute();
		return rows.map((row) => mapFieldRow(row));
	}

	async getField(slug: string): Promise<BylineFieldDefinition | null> {
		const row = await this.db
			.selectFrom("_emdash_byline_fields")
			.selectAll()
			.where("slug", "=", slug)
			.executeTakeFirst();
		return row ? mapFieldRow(row) : null;
	}

	async getFieldById(id: string): Promise<BylineFieldDefinition | null> {
		const row = await this.db
			.selectFrom("_emdash_byline_fields")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? mapFieldRow(row) : null;
	}

	async createField(input: CreateBylineFieldInput): Promise<BylineFieldDefinition> {
		this.validateSlug(input.slug);
		this.validateLabel(input.label);
		this.validateType(input.type);
		const validation = this.normaliseValidation(input.type, input.validation ?? null);

		const existing = await this.getField(input.slug);
		if (existing) {
			// Idempotent retry exit — see class JSDoc.
			await this.markVersionClean();
			throw new BylineSchemaError(`Byline field "${input.slug}" already exists`, "FIELD_EXISTS", {
				slug: input.slug,
			});
		}

		const id = ulid();
		const sortOrder = input.sortOrder ?? (await this.nextSortOrder());

		await this.markVersionDirty();
		await withTransaction(this.db, async (trx) => {
			await trx
				.insertInto("_emdash_byline_fields")
				.values({
					id,
					slug: input.slug,
					label: input.label,
					type: input.type,
					required: input.required ? 1 : 0,
					translatable: input.translatable === false ? 0 : 1,
					validation: validation ? JSON.stringify(validation) : null,
					sort_order: sortOrder,
				})
				.execute();
		});
		await this.markVersionClean();

		const created = await this.getFieldById(id);
		if (!created) {
			// Should be unreachable on a working DB — but a typed error
			// beats letting the route returning null on a successful path.
			throw new BylineSchemaError("Failed to load created field", "FIELD_NOT_FOUND", {
				id,
			});
		}
		return created;
	}

	async updateField(slug: string, input: UpdateBylineFieldInput): Promise<BylineFieldDefinition> {
		const field = await this.getField(slug);
		if (!field) {
			// Idempotent retry exit — see class JSDoc.
			await this.markVersionClean();
			throw new BylineSchemaError(`Byline field "${slug}" not found`, "FIELD_NOT_FOUND", {
				slug,
			});
		}

		const updates: Partial<{
			label: string;
			required: number;
			translatable: number;
			validation: string | null;
			sort_order: number;
			updated_at: string;
		}> = {};

		if (input.label !== undefined) {
			this.validateLabel(input.label);
			updates.label = input.label;
		}

		if (input.required !== undefined) {
			updates.required = input.required ? 1 : 0;
		}

		if (input.validation !== undefined) {
			// Validation payload is normalised against the *current* field
			// type — `type` is not updatable, so it's safe to use `field.type`.
			const validation = this.normaliseValidation(field.type, input.validation);
			updates.validation = validation ? JSON.stringify(validation) : null;
		}

		if (input.translatable !== undefined && input.translatable !== field.translatable) {
			// Flipping `translatable` would orphan any values already stored
			// in the table matching the *current* flag. Reject when any
			// value rows reference this field — admins can delete the field
			// (cascading the values) and re-create it with the new flag if
			// they want a clean re-start. Migrating values across tables is
			// out of scope (Discussion #1174 doesn't authorise it).
			const usage = await this.countFieldValues(field.id);
			if (usage > 0) {
				throw new BylineSchemaError(
					`Cannot change "translatable" on field "${slug}" while ${usage} value row(s) exist. ` +
						`Delete the values (or the field) and re-create with the new setting.`,
					"TRANSLATABLE_LOCKED",
					{ slug, valueCount: usage },
				);
			}
			updates.translatable = input.translatable ? 1 : 0;
		}

		if (input.sortOrder !== undefined) {
			updates.sort_order = input.sortOrder;
		}

		if (Object.keys(updates).length === 0) {
			// No-op update — still advance the clean marker in case
			// we're recovering a crashed prior attempt.
			await this.markVersionClean();
			return field;
		}

		updates.updated_at = new Date().toISOString();

		await this.markVersionDirty();
		await withTransaction(this.db, async (trx) => {
			await trx
				.updateTable("_emdash_byline_fields")
				.set(updates)
				.where("id", "=", field.id)
				.execute();
		});
		await this.markVersionClean();

		const updated = await this.getFieldById(field.id);
		if (!updated) {
			throw new BylineSchemaError("Failed to load updated field", "FIELD_NOT_FOUND", {
				slug,
			});
		}
		return updated;
	}

	async deleteField(slug: string): Promise<void> {
		const field = await this.getField(slug);
		if (!field) {
			// Idempotent retry exit — see class JSDoc.
			await this.markVersionClean();
			throw new BylineSchemaError(`Byline field "${slug}" not found`, "FIELD_NOT_FOUND", {
				slug,
			});
		}

		// Delete order matters on D1 (no tx): value rows first, definition
		// row last, so a crash leaves the definition recoverable on retry
		// rather than orphan values pointing at a vanished id.
		await this.markVersionDirty();
		await withTransaction(this.db, async (trx) => {
			await trx
				.deleteFrom("_emdash_byline_field_values")
				.where("field_id", "=", field.id)
				.execute();
			await trx
				.deleteFrom("_emdash_byline_field_group_values")
				.where("field_id", "=", field.id)
				.execute();
			await trx.deleteFrom("_emdash_byline_fields").where("id", "=", field.id).execute();
		});
		await this.markVersionClean();
	}

	/**
	 * Reorder fields by slug. The input must be the *exact* set of
	 * currently registered slugs — no adds, no drops, no duplicates. This
	 * keeps the operation invertible (any reorder is followed by a reverse
	 * reorder) and removes a class of "did I forget a field?" bugs at the
	 * API layer.
	 */
	async reorderFields(slugs: string[]): Promise<void> {
		if (new Set(slugs).size !== slugs.length) {
			throw new BylineSchemaError("Reorder input contains duplicate slugs", "REORDER_MISMATCH", {
				slugs,
			});
		}

		const registered = await this.listFields();
		const registeredSlugs = registered.map((f) => f.slug).toSorted();
		const inputSlugs = slugs.toSorted();

		if (registeredSlugs.length !== inputSlugs.length) {
			throw new BylineSchemaError(
				`Reorder input has ${inputSlugs.length} slug(s); ${registeredSlugs.length} registered`,
				"REORDER_MISMATCH",
				{ registered: registeredSlugs, input: inputSlugs },
			);
		}
		for (let i = 0; i < registeredSlugs.length; i++) {
			if (registeredSlugs[i] !== inputSlugs[i]) {
				throw new BylineSchemaError(
					"Reorder input does not match the registered field set",
					"REORDER_MISMATCH",
					{ registered: registeredSlugs, input: inputSlugs },
				);
			}
		}

		const now = new Date().toISOString();
		await this.markVersionDirty();
		await withTransaction(this.db, async (trx) => {
			for (let i = 0; i < slugs.length; i++) {
				const slug = slugs[i];
				if (slug === undefined) continue;
				await trx
					.updateTable("_emdash_byline_fields")
					.set({ sort_order: i, updated_at: now })
					.where("slug", "=", slug)
					.execute();
			}
		});
		await this.markVersionClean();
	}

	/**
	 * Per-table usage counts for a field, plus the sum. Backs the
	 * destructive-delete confirm dialog in the admin UI (Phase 5).
	 *
	 * Both counts are surfaced separately for diagnostic value: a
	 * non-zero count on the table that doesn't match the field's current
	 * `translatable` flag indicates historical drift (e.g. a flip from
	 * an older code path). Today the registry rejects such flips with
	 * `TRANSLATABLE_LOCKED`, so any drift originates pre-Phase-2.
	 *
	 * Throws `FIELD_NOT_FOUND` when the slug doesn't resolve — callers
	 * shouldn't get back zero counts for a missing field.
	 */
	async getFieldUsage(slug: string): Promise<{
		translatableValueCount: number;
		groupValueCount: number;
		totalAffectedRows: number;
	}> {
		const field = await this.getField(slug);
		if (!field) {
			throw new BylineSchemaError(`Byline field "${slug}" not found`, "FIELD_NOT_FOUND", {
				slug,
			});
		}
		const tr = await this.db
			.selectFrom("_emdash_byline_field_values")
			.select(({ fn }) => [fn.count<number>("field_id").as("count")])
			.where("field_id", "=", field.id)
			.executeTakeFirst();
		const grp = await this.db
			.selectFrom("_emdash_byline_field_group_values")
			.select(({ fn }) => [fn.count<number>("field_id").as("count")])
			.where("field_id", "=", field.id)
			.executeTakeFirst();
		const translatableValueCount = Number(tr?.count ?? 0);
		const groupValueCount = Number(grp?.count ?? 0);
		return {
			translatableValueCount,
			groupValueCount,
			totalAffectedRows: translatableValueCount + groupValueCount,
		};
	}

	/**
	 * Read the persisted version counter. Used by the field-defs cache
	 * (Phase 3) to detect invalidation. Returns `0` when the row is
	 * missing — covers the "tests that didn't run migration 041" case
	 * without throwing.
	 */
	async getVersion(): Promise<number> {
		const row = await this.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", VERSION_KEY)
			.executeTakeFirst();
		if (!row) return 0;
		const parsed = Number.parseInt(row.value, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	// ============================================
	// Private helpers
	// ============================================

	/**
	 * Force the version counter to an odd integer ("dirty"). Idempotent
	 * on odd so a crashed prior attempt can't invert parity. Upsert to
	 * cover the missing-row case (otherwise the flip silently no-ops).
	 * See the class JSDoc for the bookend rationale.
	 */
	private async markVersionDirty(): Promise<void> {
		await sql`
			INSERT INTO options (name, value)
			VALUES (${VERSION_KEY}, '1')
			ON CONFLICT(name) DO UPDATE SET value = CASE
				WHEN CAST(value AS INTEGER) % 2 = 0
					THEN CAST(CAST(value AS INTEGER) + 1 AS TEXT)
				ELSE value
			END
		`.execute(this.db);
	}

	/**
	 * Force the version counter to a **new** even integer (+2 from even,
	 * +1 from odd). Always-advance — never a no-op — so two concurrent
	 * mutators can't collapse on the same even key and pin a stale cache
	 * snapshot. See the class JSDoc for the concurrent-collapse rationale.
	 */
	private async markVersionClean(): Promise<void> {
		await sql`
			INSERT INTO options (name, value)
			VALUES (${VERSION_KEY}, '2')
			ON CONFLICT(name) DO UPDATE SET value = CASE
				WHEN CAST(value AS INTEGER) % 2 = 0
					THEN CAST(CAST(value AS INTEGER) + 2 AS TEXT)
				ELSE CAST(CAST(value AS INTEGER) + 1 AS TEXT)
			END
		`.execute(this.db);
	}

	private async nextSortOrder(): Promise<number> {
		const row = await this.db
			.selectFrom("_emdash_byline_fields")
			.select(({ fn }) => [fn.max<number | null>("sort_order").as("max")])
			.executeTakeFirst();
		const max = row?.max ?? null;
		return max === null ? 0 : max + 1;
	}

	private async countFieldValues(fieldId: string): Promise<number> {
		// Count both per-locale and group-shared values. A field can only
		// store in one table at a time (translatable picks), but historic
		// rows might exist in the other if a prior version of this code
		// allowed the flip — count both to be safe.
		const tr = await this.db
			.selectFrom("_emdash_byline_field_values")
			.select(({ fn }) => [fn.count<number>("field_id").as("count")])
			.where("field_id", "=", fieldId)
			.executeTakeFirst();
		const grp = await this.db
			.selectFrom("_emdash_byline_field_group_values")
			.select(({ fn }) => [fn.count<number>("field_id").as("count")])
			.where("field_id", "=", fieldId)
			.executeTakeFirst();
		return Number(tr?.count ?? 0) + Number(grp?.count ?? 0);
	}

	private validateSlug(slug: string): void {
		if (!slug || typeof slug !== "string") {
			throw new BylineSchemaError("Byline field slug is required", "INVALID_SLUG", { slug });
		}
		if (slug.length > MAX_SLUG_LENGTH) {
			throw new BylineSchemaError(
				`Byline field slug must be ${MAX_SLUG_LENGTH} characters or less`,
				"INVALID_SLUG",
				{ slug },
			);
		}
		// `validateIdentifier` enforces /^[a-z][a-z0-9_]*$/ — rejects
		// camelCase, PascalCase, hyphens, leading digits, and identifiers
		// over 128 characters. We hit the 63-char cap above first, which
		// matches the content-collection slug cap.
		try {
			validateIdentifier(slug, "byline field slug");
		} catch (error) {
			throw new BylineSchemaError(
				error instanceof Error ? error.message : "Invalid byline field slug",
				"INVALID_SLUG",
				{ slug },
			);
		}
		if (RESERVED_SET.has(slug)) {
			throw new BylineSchemaError(`Byline field slug "${slug}" is reserved`, "RESERVED_SLUG", {
				slug,
			});
		}
	}

	private validateLabel(label: string): void {
		if (!label || typeof label !== "string") {
			throw new BylineSchemaError("Byline field label is required", "INVALID_LABEL", {
				label,
			});
		}
		if (label.length > MAX_LABEL_LENGTH) {
			throw new BylineSchemaError(
				`Byline field label must be ${MAX_LABEL_LENGTH} characters or less`,
				"INVALID_LABEL",
				{ length: label.length },
			);
		}
	}

	private validateType(type: BylineFieldType): void {
		if (!TYPE_SET.has(type)) {
			throw new BylineSchemaError(
				`Byline field type "${type}" is not supported. Valid types: ${[...TYPE_SET].join(", ")}`,
				"INVALID_TYPE",
				{ type },
			);
		}
	}

	/**
	 * Normalise + validate a validation payload for a given field type.
	 *
	 * - `select`: `options` is required, must be a non-empty array of unique
	 *   non-empty strings, capped at `MAX_SELECT_OPTIONS`.
	 * - any other type: `options` is silently dropped if present (a future
	 *   field type might use it, but v1 doesn't).
	 *
	 * Returns `null` when the resulting validation object is empty, so the
	 * storage column stays NULL rather than carrying `'{}'`.
	 */
	private normaliseValidation(
		type: BylineFieldType,
		validation: BylineFieldValidation | null,
	): BylineFieldValidation | null {
		if (type === "select") {
			const options = validation?.options;
			if (!Array.isArray(options) || options.length === 0) {
				throw new BylineSchemaError(
					`Byline field of type "select" requires non-empty "validation.options"`,
					"INVALID_VALIDATION",
					{ type },
				);
			}
			if (options.length > MAX_SELECT_OPTIONS) {
				throw new BylineSchemaError(
					`Byline field "select" cannot have more than ${MAX_SELECT_OPTIONS} options`,
					"INVALID_VALIDATION",
					{ count: options.length },
				);
			}
			const seen = new Set<string>();
			for (const option of options) {
				if (typeof option !== "string" || option.length === 0) {
					throw new BylineSchemaError(
						`Byline field "select" options must be non-empty strings`,
						"INVALID_VALIDATION",
						{ option },
					);
				}
				if (seen.has(option)) {
					throw new BylineSchemaError(
						`Byline field "select" options must be unique`,
						"INVALID_VALIDATION",
						{ option },
					);
				}
				seen.add(option);
			}
			return { options };
		}

		if (validation == null) return null;
		// Non-select: drop `options` if present. Strip nothing else — future
		// field types might extend the shape and we don't want to lose
		// payload silently. Today's `BylineFieldValidation` is `{ options? }`
		// only, so this branch is a pass-through; left explicit for clarity.
		const { options: _drop, ...rest } = validation;
		return Object.keys(rest).length === 0 ? null : (rest as BylineFieldValidation);
	}
}

function mapFieldRow(row: {
	id: string;
	slug: string;
	label: string;
	type: string;
	required: number;
	translatable: number;
	validation: string | null;
	sort_order: number;
	created_at: string;
	updated_at: string;
}): BylineFieldDefinition {
	return {
		id: row.id,
		slug: row.slug,
		label: row.label,
		// `type` is stored as TEXT but `createField` rejects anything outside
		// `BYLINE_FIELD_TYPES` before inserting. The assertion narrows on
		// that write-time guarantee.
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- validated at write
		type: row.type as BylineFieldType,
		required: row.required === 1,
		translatable: row.translatable === 1,
		// `validation` is JSON-encoded `BylineFieldValidation | null`, written
		// only through `normaliseValidation`. The cast matches the
		// `JSON.parse(...) as T` pattern in `OptionsRepository`.
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- validated at write
		validation: row.validation ? (JSON.parse(row.validation) as BylineFieldValidation) : null,
		sortOrder: row.sort_order,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// Re-export the table type for callers that want to spell it explicitly.
// Most callers should rely on the Database interface; this is convenience
// for tests that hand-roll Kysely queries.
export type { BylineFieldTable };
