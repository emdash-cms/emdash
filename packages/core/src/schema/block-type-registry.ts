import { sql, type Kysely, type RawBuilder, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { refreshDevTypes } from "../astro/dev-typegen.js";
import {
	currentTimestampValue,
	executeAtomicBatchIfSupported,
} from "../database/dialect-helpers.js";
import { withTransaction } from "../database/transaction.js";
import type { BlockTypeTable, BlockTypeVersionTable, Database } from "../database/types.js";
import {
	invalidateContentMediaUsageSchemaChange,
	markContentMediaUsageCollectionStaleSafely,
} from "../media/usage/schema-invalidation.js";
import {
	compareBlockFields,
	fingerprintBlockFields,
	validateBlockFields,
} from "./block-type-contract.js";
import {
	BLOCK_FIELD_TYPES,
	type BlockFieldDefinition,
	type BlockFieldType,
	type BlockType,
	type BlockTypeSource,
	type BlockTypeVersion,
	type CreateBlockTypeInput,
	type UpdateBlockTypeInput,
	type ApplySeedBlockTypeInput,
} from "./block-types.js";
import { SchemaError } from "./registry.js";
import { REPEATER_SUB_FIELD_TYPES, RESERVED_FIELD_SLUGS } from "./types.js";
import { invalidateSchemaCache } from "./zod-generator.js";

const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_SLUG_LENGTH = 63;
const MAX_LABEL_LENGTH = 200;
const UNIQUE_VIOLATION = /unique constraint failed|duplicate key value violates unique constraint/i;
const BLOCK_FIELD_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_FIELD_TYPES);
const REPEATER_SUB_FIELD_TYPE_SET: ReadonlySet<string> = new Set(REPEATER_SUB_FIELD_TYPES);
const RESERVED_BLOCK_TYPE_SLUGS: ReadonlySet<string> = new Set(RESERVED_FIELD_SLUGS);

interface ParsedStoredFields {
	fields: BlockFieldDefinition[];
	unsupportedTypes: Array<{ type: string; path: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function executeAtomicStatements(
	db: Kysely<Database>,
	statements: readonly RawBuilder<{ id: string }>[],
): Promise<number[]> {
	const batched = await executeAtomicBatchIfSupported(db, statements);
	if (batched) return batched.map((result) => result.rows.length);
	return withTransaction(db, async (trx) => {
		const counts: number[] = [];
		for (const statement of statements) {
			// oxlint-disable-next-line no-await-in-loop -- statement order is the mutation's atomic contract
			counts.push((await statement.execute(trx)).rows.length);
		}
		return counts;
	});
}

function assertBlockTypeSlug(slug: string): void {
	if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
		throw new SchemaError(`Invalid block type slug "${slug}"`, "INVALID_SLUG", { slug });
	}
	if (RESERVED_BLOCK_TYPE_SLUGS.has(slug)) {
		throw new SchemaError(`Block type slug "${slug}" is reserved`, "RESERVED_SLUG", { slug });
	}
}

function assertLabel(label: string): void {
	if (label.trim().length === 0 || label.length > MAX_LABEL_LENGTH) {
		throw new SchemaError(
			`Block type label must contain between 1 and ${MAX_LABEL_LENGTH} characters`,
			"VALIDATION_ERROR",
			{ path: "label" },
		);
	}
}

function sourceValue(source: string): BlockTypeSource {
	if (source === "user" || source === "seed") return source;
	throw new SchemaError(
		`Stored block type source "${source}" is unsupported`,
		"BLOCK_TYPE_VERSION_CONFLICT",
	);
}

function parseStoredFields(raw: string): ParsedStoredFields {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new SchemaError(
			"Stored block type fields are not an array",
			"BLOCK_TYPE_VERSION_CONFLICT",
		);
	}
	const unsupportedTypes: Array<{ type: string; path: string }> = [];
	const fields = parsed.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.slug !== "string" || typeof entry.label !== "string") {
			throw new SchemaError(
				`Stored block type field at index ${index} is invalid`,
				"BLOCK_TYPE_VERSION_CONFLICT",
			);
		}
		const rawType = entry.type;
		if (typeof rawType !== "string") {
			throw new SchemaError(
				`Stored block type field at index ${index} has no valid type`,
				"BLOCK_TYPE_VERSION_CONFLICT",
			);
		}
		const type: BlockFieldType = BLOCK_FIELD_TYPE_SET.has(rawType)
			? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- membership in the complete runtime type set narrows this database string
				(rawType as BlockFieldType)
			: "string";
		if (!BLOCK_FIELD_TYPE_SET.has(rawType)) {
			unsupportedTypes.push({ type: rawType, path: `fields[${index}].type` });
		}
		if (type === "repeater" && isRecord(entry.validation)) {
			const subFields = entry.validation.subFields;
			if (Array.isArray(subFields)) {
				for (const [subIndex, subField] of subFields.entries()) {
					if (!isRecord(subField) || typeof subField.type !== "string") continue;
					if (!REPEATER_SUB_FIELD_TYPE_SET.has(subField.type)) {
						unsupportedTypes.push({
							type: subField.type,
							path: `fields[${index}].validation.subFields[${subIndex}].type`,
						});
					}
				}
			}
		}
		// Stored definitions are written only after `validateBlockFields`. The
		// runtime checks type discriminants above before exposing this shape and
		// carries every unknown discriminant separately in `unsupportedTypes`.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated database JSON with fail-closed discriminants
		return { ...entry, type } as unknown as BlockFieldDefinition;
	});
	return {
		fields: unsupportedTypes.length === 0 ? validateBlockFields(fields) : fields,
		unsupportedTypes,
	};
}

function mapVersion(
	row: Selectable<BlockTypeVersionTable>,
	currentVersion: number,
): BlockTypeVersion {
	const parsed = parseStoredFields(row.fields);
	return {
		id: row.id,
		blockTypeId: row.block_type_id,
		version: row.version,
		fields: parsed.fields,
		fingerprint: row.fingerprint,
		active: row.version === currentVersion,
		unsupportedTypes: parsed.unsupportedTypes.length > 0 ? parsed.unsupportedTypes : undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapBlockType(
	row: Selectable<BlockTypeTable>,
	versions: readonly Selectable<BlockTypeVersionTable>[],
): BlockType {
	return {
		id: row.id,
		slug: row.slug,
		label: row.label,
		description: row.description ?? undefined,
		icon: row.icon ?? undefined,
		category: row.category ?? undefined,
		currentVersion: row.current_version,
		source: sourceValue(row.source),
		versions: versions.map((version) => mapVersion(version, row.current_version)),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function activeVersion(blockType: BlockType): BlockTypeVersion {
	const version = blockType.versions.find(
		(candidate) => candidate.version === blockType.currentVersion,
	);
	if (!version) {
		throw new SchemaError(
			`Block type "${blockType.slug}" has no active version ${blockType.currentVersion}`,
			"BLOCK_TYPE_VERSION_CONFLICT",
			{ slug: blockType.slug, version: blockType.currentVersion },
		);
	}
	return version;
}

export class BlockTypeRegistry {
	constructor(private db: Kysely<Database>) {}

	async listBlockTypes(): Promise<BlockType[]> {
		const [types, versions] = await Promise.all([
			this.db.selectFrom("_emdash_block_types").selectAll().orderBy("slug", "asc").execute(),
			this.db
				.selectFrom("_emdash_block_type_versions")
				.selectAll()
				.orderBy("block_type_id", "asc")
				.orderBy("version", "asc")
				.execute(),
		]);
		const byType = new Map<string, Selectable<BlockTypeVersionTable>[]>();
		for (const version of versions) {
			const entries = byType.get(version.block_type_id) ?? [];
			entries.push(version);
			byType.set(version.block_type_id, entries);
		}
		return types.map((type) => mapBlockType(type, byType.get(type.id) ?? []));
	}

	async getBlockType(slug: string): Promise<BlockType | null> {
		const row = await this.db
			.selectFrom("_emdash_block_types")
			.selectAll()
			.where("slug", "=", slug)
			.executeTakeFirst();
		if (!row) return null;
		const versions = await this.db
			.selectFrom("_emdash_block_type_versions")
			.selectAll()
			.where("block_type_id", "=", row.id)
			.orderBy("version", "asc")
			.execute();
		return mapBlockType(row, versions);
	}

	async listAffectedCollections(blockTypeSlug: string): Promise<string[]> {
		const rows = await this.db
			.selectFrom("_emdash_fields as field")
			.innerJoin("_emdash_collections as collection", "collection.id", "field.collection_id")
			.select(["collection.slug as collection", "field.validation"])
			.where("field.type", "=", "blocks")
			.execute();
		const affected = new Set<string>();
		for (const row of rows) {
			if (!row.validation) continue;
			const validation: unknown = JSON.parse(row.validation);
			if (!isRecord(validation)) continue;
			const allowed = Array.isArray(validation.allowedTypes) ? validation.allowedTypes : [];
			const retired = Array.isArray(validation.retiredTypes) ? validation.retiredTypes : [];
			if ([...allowed, ...retired].includes(blockTypeSlug)) affected.add(row.collection);
		}
		return [...affected].toSorted();
	}

	private async beginMediaSchemaMutation(slug: string): Promise<ReadonlySet<string>> {
		const invalidated = new Set<string>();
		for (const collection of await this.listAffectedCollections(slug)) {
			if (await invalidateContentMediaUsageSchemaChange(this.db, collection)) {
				invalidated.add(collection);
			}
		}
		return invalidated;
	}

	private async notifyMutation(
		slug: string,
		mediaInvalidated?: ReadonlySet<string>,
	): Promise<void> {
		const collections = await this.listAffectedCollections(slug);
		for (const collection of collections) {
			invalidateSchemaCache(collection);
			if (!mediaInvalidated) continue;
			if (mediaInvalidated.has(collection)) {
				await invalidateContentMediaUsageSchemaChange(this.db, collection);
			} else {
				await markContentMediaUsageCollectionStaleSafely(
					this.db,
					collection,
					"CONTENT_USAGE_STALE",
				);
			}
		}
		refreshDevTypes(this.db);
	}

	async createBlockType(input: CreateBlockTypeInput): Promise<BlockType> {
		assertBlockTypeSlug(input.slug);
		assertLabel(input.label);
		if (input.source !== undefined && input.source !== "user" && input.source !== "seed") {
			throw new SchemaError(
				`Invalid block type source "${String(input.source)}"`,
				"VALIDATION_ERROR",
				{
					path: "source",
				},
			);
		}
		const fields = validateBlockFields(input.fields);
		const fingerprint = await fingerprintBlockFields(fields);
		const typeId = ulid();
		const versionId = ulid();
		const mediaInvalidated = await this.beginMediaSchemaMutation(input.slug);
		try {
			await executeAtomicStatements(this.db, [
				sql<{ id: string }>`
					INSERT INTO _emdash_block_types (
						id, slug, label, description, icon, category, current_version, source
					) VALUES (
						${typeId}, ${input.slug}, ${input.label}, ${input.description ?? null},
						${input.icon ?? null}, ${input.category ?? null}, 1, ${input.source ?? "user"}
					)
					RETURNING id
				`,
				sql<{ id: string }>`
					INSERT INTO _emdash_block_type_versions (
						id, block_type_id, version, fields, fingerprint
					) VALUES (
						${versionId}, ${typeId}, 1, ${JSON.stringify(fields)}, ${fingerprint}
					)
					RETURNING id
				`,
			]);
		} catch (error) {
			if (error instanceof Error && UNIQUE_VIOLATION.test(error.message)) {
				throw new SchemaError(`Block type "${input.slug}" already exists`, "BLOCK_TYPE_EXISTS", {
					slug: input.slug,
				});
			}
			throw error;
		}
		const created = await this.getBlockType(input.slug);
		if (!created) {
			throw new SchemaError(`Block type "${input.slug}" was not created`, "BLOCK_TYPE_NOT_FOUND");
		}
		await this.notifyMutation(input.slug, mediaInvalidated);
		return created;
	}

	async updateBlockType(slug: string, input: UpdateBlockTypeInput): Promise<BlockType> {
		const existing = await this.getBlockType(slug);
		if (!existing) {
			throw new SchemaError(`Block type "${slug}" not found`, "BLOCK_TYPE_NOT_FOUND", { slug });
		}
		const active = activeVersion(existing);
		if (active.unsupportedTypes?.length) {
			throw new SchemaError(
				`Block type "${slug}" contains unsupported field types`,
				"UNSUPPORTED_FIELD_TYPE",
				{ unsupportedTypes: active.unsupportedTypes },
			);
		}
		if (active.fingerprint !== input.expectedFingerprint) {
			throw new SchemaError(`Block type "${slug}" changed since it was read`, "CONFLICT", {
				expectedFingerprint: input.expectedFingerprint,
				actualFingerprint: active.fingerprint,
			});
		}
		if (input.label !== undefined) assertLabel(input.label);

		const fields = input.fields === undefined ? undefined : validateBlockFields(input.fields);
		const compatibility = fields ? compareBlockFields(active.fields, fields) : undefined;
		if (compatibility && !compatibility.compatible && !input.breaking) {
			throw new SchemaError(
				`Block type "${slug}" update requires a new version`,
				"BLOCK_TYPE_BREAKING_CHANGE",
				{ differences: compatibility.differences },
			);
		}

		const nextFingerprint = fields ? await fingerprintBlockFields(fields) : active.fingerprint;
		const metadataAssignments: RawBuilder<unknown>[] = [
			sql`updated_at = ${currentTimestampValue(this.db)}`,
		];
		if (input.label !== undefined) metadataAssignments.push(sql`label = ${input.label}`);
		if (input.description !== undefined) {
			metadataAssignments.push(sql`description = ${input.description}`);
		}
		if (input.icon !== undefined) metadataAssignments.push(sql`icon = ${input.icon}`);
		if (input.category !== undefined) metadataAssignments.push(sql`category = ${input.category}`);
		const metadataUpdate = sql<{ id: string }>`
			UPDATE _emdash_block_types
			SET ${sql.join(metadataAssignments, sql`, `)}
			WHERE id = ${existing.id}
				AND EXISTS (
					SELECT 1 FROM _emdash_block_type_versions
					WHERE block_type_id = ${existing.id}
						AND version = _emdash_block_types.current_version
						AND fingerprint = ${input.expectedFingerprint}
				)
			RETURNING id
		`;
		const mediaInvalidated =
			fields && nextFingerprint !== active.fingerprint
				? await this.beginMediaSchemaMutation(slug)
				: undefined;

		if (compatibility && !compatibility.compatible && fields) {
			const existingRetry = existing.versions.find(
				(version) =>
					version.version !== existing.currentVersion &&
					version.fingerprint === nextFingerprint &&
					JSON.stringify(version.fields) === JSON.stringify(fields),
			);
			if (!existingRetry) {
				const nextVersion = Math.max(...existing.versions.map((version) => version.version)) + 1;
				try {
					const counts = await executeAtomicStatements(this.db, [
						sql<{ id: string }>`
							INSERT INTO _emdash_block_type_versions (
								id, block_type_id, version, fields, fingerprint
							)
							SELECT
								${ulid()}, ${existing.id}, ${nextVersion},
								${JSON.stringify(fields)}, ${nextFingerprint}
							WHERE EXISTS (
								SELECT 1 FROM _emdash_block_type_versions
								WHERE block_type_id = ${existing.id}
									AND version = ${existing.currentVersion}
									AND fingerprint = ${input.expectedFingerprint}
							)
							RETURNING id
						`,
						metadataUpdate,
					]);
					if (counts[0] !== 1 || counts[1] !== 1) {
						throw new SchemaError(`Block type "${slug}" changed since it was read`, "CONFLICT");
					}
				} catch (error) {
					if (error instanceof SchemaError) throw error;
					if (error instanceof Error && UNIQUE_VIOLATION.test(error.message)) {
						const reread = await this.getBlockType(slug);
						const raced = reread?.versions.find((version) => version.version === nextVersion);
						if (
							raced?.fingerprint !== nextFingerprint ||
							JSON.stringify(raced.fields) !== JSON.stringify(fields)
						) {
							throw new SchemaError(
								`Block type "${slug}" version ${nextVersion} was created concurrently with a different contract`,
								"BLOCK_TYPE_VERSION_CONFLICT",
								{ version: nextVersion },
							);
						}
					} else {
						throw error;
					}
				}
			} else {
				const counts = await executeAtomicStatements(this.db, [metadataUpdate]);
				if (counts[0] !== 1) {
					throw new SchemaError(`Block type "${slug}" changed since it was read`, "CONFLICT");
				}
			}
		} else if (fields) {
			const counts = await executeAtomicStatements(this.db, [
				metadataUpdate,
				sql<{ id: string }>`
					UPDATE _emdash_block_type_versions
					SET fields = ${JSON.stringify(fields)},
						fingerprint = ${nextFingerprint},
						updated_at = ${currentTimestampValue(this.db)}
					WHERE block_type_id = ${existing.id}
						AND version = ${active.version}
						AND fingerprint = ${input.expectedFingerprint}
					RETURNING id
				`,
			]);
			if (counts[0] !== 1 || counts[1] !== 1) {
				throw new SchemaError(`Block type "${slug}" changed since it was read`, "CONFLICT");
			}
		} else {
			const counts = await executeAtomicStatements(this.db, [metadataUpdate]);
			if (counts[0] !== 1) {
				throw new SchemaError(`Block type "${slug}" changed since it was read`, "CONFLICT");
			}
		}

		const updated = await this.getBlockType(slug);
		if (!updated) throw new SchemaError(`Block type "${slug}" not found`, "BLOCK_TYPE_NOT_FOUND");
		await this.notifyMutation(slug, mediaInvalidated);
		return updated;
	}

	async applySeedBlockType(
		input: ApplySeedBlockTypeInput,
		onConflict: "skip" | "error" | "update" = "skip",
	): Promise<BlockType> {
		assertBlockTypeSlug(input.slug);
		assertLabel(input.label);
		const versions = await Promise.all(
			input.versions
				.toSorted((left, right) => left.version - right.version)
				.map(async (version) => ({
					version: version.version,
					fields: validateBlockFields(version.fields),
					fingerprint: await fingerprintBlockFields(version.fields),
				})),
		);
		if (
			versions.length === 0 ||
			versions[0]?.version !== 1 ||
			versions.some(
				(version, index) =>
					!Number.isInteger(version.version) ||
					version.version < 1 ||
					(index > 0 && version.version !== versions[index - 1].version + 1),
			)
		) {
			throw new SchemaError(
				`Block type "${input.slug}" versions must be contiguous positive integers starting at 1`,
				"BLOCK_TYPE_VERSION_CONFLICT",
			);
		}
		if (!versions.some((version) => version.version === input.currentVersion)) {
			throw new SchemaError(
				`Block type "${input.slug}" currentVersion ${input.currentVersion} is not declared`,
				"BLOCK_TYPE_VERSION_CONFLICT",
			);
		}

		const existing = await this.getBlockType(input.slug);
		if (existing && onConflict === "error") {
			throw new SchemaError(`Block type "${input.slug}" already exists`, "BLOCK_TYPE_EXISTS");
		}
		if (existing && onConflict === "skip") return existing;
		const mediaInvalidated = await this.beginMediaSchemaMutation(input.slug);

		if (!existing) {
			const typeId = ulid();
			const statements: RawBuilder<{ id: string }>[] = [
				sql<{ id: string }>`
					INSERT INTO _emdash_block_types (
						id, slug, label, description, icon, category, current_version, source
					) VALUES (
						${typeId}, ${input.slug}, ${input.label}, ${input.description ?? null},
						${input.icon ?? null}, ${input.category ?? null}, ${input.currentVersion}, 'seed'
					)
					RETURNING id
				`,
			];
			for (const version of versions) {
				statements.push(sql<{ id: string }>`
					INSERT INTO _emdash_block_type_versions (
						id, block_type_id, version, fields, fingerprint
					) VALUES (
						${ulid()}, ${typeId}, ${version.version},
						${JSON.stringify(version.fields)}, ${version.fingerprint}
					)
					RETURNING id
				`);
			}
			try {
				await executeAtomicStatements(this.db, statements);
			} catch (error) {
				if (error instanceof Error && UNIQUE_VIOLATION.test(error.message)) {
					throw new SchemaError(`Block type "${input.slug}" already exists`, "BLOCK_TYPE_EXISTS");
				}
				throw error;
			}
		} else {
			const statements: RawBuilder<{ id: string }>[] = [
				sql<{ id: string }>`
					UPDATE _emdash_block_types
					SET label = ${input.label}, description = ${input.description ?? null},
						icon = ${input.icon ?? null}, category = ${input.category ?? null},
						updated_at = ${currentTimestampValue(this.db)}
					WHERE id = ${existing.id}
					RETURNING id
				`,
			];
			for (const version of versions) {
				const stored = existing.versions.find((candidate) => candidate.version === version.version);
				if (stored) {
					if (stored.unsupportedTypes?.length) {
						throw new SchemaError(
							`Block type "${input.slug}" version ${version.version} contains unsupported field types`,
							"UNSUPPORTED_FIELD_TYPE",
							{ unsupportedTypes: stored.unsupportedTypes },
						);
					}
					if (
						stored.fingerprint !== version.fingerprint &&
						!compareBlockFields(stored.fields, version.fields).compatible
					) {
						throw new SchemaError(
							`Block type "${input.slug}" version ${version.version} has an incompatible stored contract`,
							"BLOCK_TYPE_VERSION_CONFLICT",
							{ version: version.version },
						);
					}
					statements.push(sql<{ id: string }>`
						UPDATE _emdash_block_type_versions
						SET fields = ${JSON.stringify(version.fields)},
							fingerprint = ${version.fingerprint},
							updated_at = ${currentTimestampValue(this.db)}
						WHERE id = ${stored.id}
						RETURNING id
					`);
				} else {
					statements.push(sql<{ id: string }>`
						INSERT INTO _emdash_block_type_versions (
							id, block_type_id, version, fields, fingerprint
						) VALUES (
							${ulid()}, ${existing.id}, ${version.version},
							${JSON.stringify(version.fields)}, ${version.fingerprint}
						)
						RETURNING id
					`);
				}
			}
			statements.push(sql<{ id: string }>`
				UPDATE _emdash_block_types
				SET current_version = ${input.currentVersion},
					updated_at = ${currentTimestampValue(this.db)}
				WHERE id = ${existing.id}
				RETURNING id
			`);
			await executeAtomicStatements(this.db, statements);
		}

		const applied = await this.getBlockType(input.slug);
		if (!applied) {
			throw new SchemaError(`Block type "${input.slug}" not found`, "BLOCK_TYPE_NOT_FOUND");
		}
		await this.notifyMutation(input.slug, mediaInvalidated);
		return applied;
	}

	async activateVersion(
		slug: string,
		version: number,
		expectedFingerprint: string,
	): Promise<BlockType> {
		const existing = await this.getBlockType(slug);
		if (!existing) {
			throw new SchemaError(`Block type "${slug}" not found`, "BLOCK_TYPE_NOT_FOUND", { slug });
		}
		const active = activeVersion(existing);
		if (active.fingerprint !== expectedFingerprint) {
			throw new SchemaError(`Block type "${slug}" changed since it was read`, "CONFLICT", {
				expectedFingerprint,
				actualFingerprint: active.fingerprint,
			});
		}
		const target = existing.versions.find((candidate) => candidate.version === version);
		if (!target) {
			throw new SchemaError(
				`Block type "${slug}" has no version ${version}`,
				"BLOCK_TYPE_VERSION_CONFLICT",
				{ slug, version },
			);
		}
		if (target.unsupportedTypes?.length) {
			throw new SchemaError(
				`Block type "${slug}" version ${version} contains unsupported field types`,
				"UNSUPPORTED_FIELD_TYPE",
				{ unsupportedTypes: target.unsupportedTypes },
			);
		}
		const mediaInvalidated =
			version !== existing.currentVersion ? await this.beginMediaSchemaMutation(slug) : undefined;
		if (version !== existing.currentVersion) {
			const result = await sql<{ id: string }>`
				UPDATE _emdash_block_types
				SET current_version = ${version},
					updated_at = ${currentTimestampValue(this.db)}
				WHERE id = ${existing.id}
					AND current_version = ${existing.currentVersion}
					AND EXISTS (
						SELECT 1 FROM _emdash_block_type_versions
						WHERE block_type_id = ${existing.id}
							AND version = ${existing.currentVersion}
							AND fingerprint = ${expectedFingerprint}
					)
				RETURNING id
			`.execute(this.db);
			if (result.rows.length !== 1) {
				throw new SchemaError(`Block type "${slug}" changed since it was read`, "CONFLICT");
			}
		}
		const updated = await this.getBlockType(slug);
		if (!updated) throw new SchemaError(`Block type "${slug}" not found`, "BLOCK_TYPE_NOT_FOUND");
		await this.notifyMutation(slug, mediaInvalidated);
		return updated;
	}
}
