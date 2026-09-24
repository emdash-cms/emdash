/**
 * State shared by one `advanceImport` step.
 */

import type { Kysely } from "kysely";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";
import type { Storage } from "../../storage/types.js";
import { TransferError } from "../errors.js";
import {
	KIND_REFERENCES,
	RECORD_KINDS,
	type RecordKind,
	type RecordOfKind,
} from "../format/kinds.js";
import type { SitePackageManifest } from "../format/manifest.js";
import {
	MEDIA_PLACEHOLDER_PREFIX,
	PLACEHOLDER_TOKEN,
	rewriteMediaRefs,
} from "../format/media-refs.js";
import type { SiteImportPlan } from "../format/plan.js";
import type { FieldColumnType } from "../format/transformations.js";
import type { TransferStepBudget } from "../ops/budget.js";
import { MEDIA_STORAGE_KEY_ENTITY, TransferIdentityMapRepository } from "../ops/identity-map.js";
import type { TransferOperation, TransferOperationRepository } from "../ops/operations.js";
import type { StreamPosition } from "../ops/states.js";
import type { StagedPackageReader, StagedRecord } from "../staging/package.js";

const RECORD_KIND_NAMES: ReadonlySet<string> = new Set(RECORD_KINDS);

/** Identity-map kind marking record-stage units that have started. */
export const IMPORT_UNIT_ENTITY = "import_unit";

interface CollectionFields {
	columns: ReadonlyMap<string, FieldColumnType>;
	required: ReadonlySet<string>;
}

export class ImportContext {
	readonly float4: boolean;
	readonly identity: TransferIdentityMapRepository;
	readonly #chunks = new Map<string, Promise<Array<StagedRecord<RecordKind>>>>();
	readonly #fields = new Map<string, Promise<CollectionFields>>();
	#rewrittenKinds: Promise<Set<string>> | undefined;
	/** Whether the running unit is on its first attempt (see `beginUnit`). */
	firstAttempt = false;

	constructor(
		readonly db: Kysely<Database>,
		readonly storage: Storage,
		readonly ops: TransferOperationRepository,
		public operation: TransferOperation,
		readonly leaseToken: string,
		readonly plan: SiteImportPlan,
		readonly manifest: SitePackageManifest,
		readonly reader: StagedPackageReader,
		readonly budget: TransferStepBudget,
	) {
		this.float4 = isPostgres(db);
		this.identity = new TransferIdentityMapRepository(db, manifest.originSiteId, operation.id);
	}

	get operationId(): string {
		return this.operation.id;
	}

	chunkCount(kind: RecordKind): number {
		return this.manifest.records[kind]?.chunks ?? 0;
	}

	/** Records of one chunk, parsed once per step. */
	async chunk<K extends RecordKind>(kind: K, seq: number): Promise<Array<StagedRecord<K>>> {
		const key = `${kind}/${seq}`;
		let pending = this.#chunks.get(key);
		if (!pending) {
			pending = this.reader.readChunk(kind, seq);
			this.#chunks.set(key, pending);
		}
		return pending;
	}

	/** Every record of `kind`, for small kinds read as a whole (collections, fields). */
	async allRecords<K extends RecordKind>(kind: K): Promise<Array<RecordOfKind<K>>> {
		const records: Array<RecordOfKind<K>> = [];
		for (let seq = 0; seq < this.chunkCount(kind); seq++) {
			for (const staged of await this.chunk(kind, seq)) records.push(staged.record);
		}
		return records;
	}

	/** Target column type of each field of a collection, from the imported schema. */
	async fieldColumns(collection: string): Promise<ReadonlyMap<string, FieldColumnType>> {
		return (await this.fields(collection)).columns;
	}

	/** Slugs of a collection's required (NOT NULL) fields, from the imported schema. */
	async requiredFields(collection: string): Promise<ReadonlySet<string>> {
		return (await this.fields(collection)).required;
	}

	private fields(collection: string): Promise<CollectionFields> {
		let pending = this.#fields.get(collection);
		if (!pending) {
			pending = this.db
				.selectFrom("_emdash_fields")
				.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
				.select([
					"_emdash_fields.slug as slug",
					"_emdash_fields.column_type as column_type",
					"_emdash_fields.required as required",
				])
				.where("_emdash_collections.slug", "=", collection)
				.execute()
				.then((rows) => ({
					columns: new Map(
						rows.map((row) => [row.slug, toFieldColumnType(row.column_type)] as const),
					),
					required: new Set(
						rows.filter((row) => Number(row.required) === 1).map((row) => row.slug),
					),
				}));
			this.#fields.set(collection, pending);
		}
		return pending;
	}

	/**
	 * Record that the unit at `position` of `stage` is starting and set
	 * `firstAttempt`: false when an earlier, interrupted step already started
	 * it, so rows it finds may be its own partial writes.
	 */
	async beginUnit(stage: string, position: StreamPosition): Promise<void> {
		const result = await this.db
			.insertInto("_emdash_transfer_identity_map")
			.values({
				origin_site_id: this.manifest.originSiteId,
				operation_id: this.operation.id,
				entity_kind: IMPORT_UNIT_ENTITY,
				portable_id: `${stage}:${position.kind}:${position.seq}:${position.line}`,
				target_id: "started",
			})
			.onConflict((conflict) =>
				conflict.columns(["operation_id", "entity_kind", "portable_id"]).doNothing(),
			)
			.executeTakeFirst();
		this.firstAttempt = Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
	}

	principalTarget(principal: string | undefined): string | null {
		if (principal === undefined) return null;
		const mappings = this.plan.decisions.principalMappings;
		return Object.hasOwn(mappings, principal) ? (mappings[principal] ?? null) : null;
	}

	/**
	 * Replace every `emdash-media:` placeholder in `records` with the target
	 * storage key the media stage recorded, and unescape escaped placeholder
	 * text. Throws `TRANSFER_MEDIA_REF_INVALID` for a placeholder whose media
	 * was not imported.
	 */
	async resolveMediaRefs<R extends { kind: RecordKind; id: string }>(
		records: readonly R[],
		lines: readonly string[],
	): Promise<R[]> {
		const mediaIds = new Set<string>();
		let marked = false;
		for (const line of lines) {
			if (!line.includes(MEDIA_PLACEHOLDER_PREFIX)) continue;
			marked = true;
			for (const match of line.matchAll(PLACEHOLDER_TOKEN)) {
				if (match[2] !== undefined) mediaIds.add(match[2]);
			}
		}
		if (!marked) return [...records];
		const mediaIdToKey = await this.identity.getMany(MEDIA_STORAGE_KEY_ENTITY, [...mediaIds]);
		return records.map((record) => {
			const result = rewriteMediaRefs(record, { mode: "import", mediaIdToKey });
			const error = result.errors[0];
			if (error) {
				throw new TransferError("TRANSFER_MEDIA_REF_INVALID", "Unresolved media reference", {
					detail: { kind: record.kind, id: record.id, path: error.path },
				});
			}
			return result.value;
		});
	}

	/** Record kinds that have at least one rewritten id in this import. */
	rewrittenKinds(): Promise<Set<string>> {
		this.#rewrittenKinds ??= this.db
			.selectFrom("_emdash_transfer_identity_map")
			.select("entity_kind")
			.distinct()
			.where("operation_id", "=", this.operation.id)
			.execute()
			.then((rows) => new Set(rows.map((row) => row.entity_kind).filter(isRecordKindName)));
		return this.#rewrittenKinds;
	}

	noteRewrite(kind: RecordKind): void {
		const current = this.#rewrittenKinds;
		this.#rewrittenKinds = (current ?? Promise.resolve(new Set<string>())).then((kinds) =>
			kinds.add(kind),
		);
	}

	/**
	 * Target ids for the records' own ids and every `by: "id"` reference,
	 * keyed `kind\u0000portableId`. Ids without a rewrite are absent.
	 */
	async rewrittenIds(
		kind: RecordKind,
		records: ReadonlyArray<Record<string, unknown>>,
	): Promise<Map<string, string>> {
		const rewritten = await this.rewrittenKinds();
		const result = new Map<string, string>();
		if (rewritten.size === 0) return result;
		const wanted = new Map<string, Set<string>>();
		const want = (targetKind: RecordKind, id: unknown) => {
			if (typeof id !== "string" || !rewritten.has(targetKind)) return;
			let ids = wanted.get(targetKind);
			if (!ids) wanted.set(targetKind, (ids = new Set()));
			ids.add(id);
		};
		for (const record of records) {
			want(kind, record.id);
			for (const reference of KIND_REFERENCES[kind]) {
				if (reference.by !== "id") continue;
				for (const target of reference.targets) want(target, record[reference.property]);
			}
		}
		for (const [targetKind, ids] of wanted) {
			for (const [portableId, targetId] of await this.identity.getMany(targetKind, [...ids])) {
				result.set(`${targetKind}\u0000${portableId}`, targetId);
			}
		}
		return result;
	}
}

function isRecordKindName(value: string): boolean {
	return RECORD_KIND_NAMES.has(value);
}

function toFieldColumnType(value: string): FieldColumnType {
	switch (value) {
		case "REAL":
		case "INTEGER":
		case "JSON":
			return value;
		default:
			return "TEXT";
	}
}

/** Apply rewritten ids to a record's own id and `by: "id"` references. */
export function applyRewrittenIds<R extends { kind: RecordKind; id: string }>(
	record: R,
	rewritten: ReadonlyMap<string, string>,
): R {
	if (rewritten.size === 0) return record;
	const next: Record<string, unknown> = { ...record };
	const own = rewritten.get(`${record.kind}\u0000${record.id}`);
	if (own !== undefined) next.id = own;
	for (const reference of KIND_REFERENCES[record.kind]) {
		if (reference.by !== "id") continue;
		const value = next[reference.property];
		if (typeof value !== "string") continue;
		for (const target of reference.targets) {
			const mapped = rewritten.get(`${target}\u0000${value}`);
			if (mapped !== undefined) {
				next[reference.property] = mapped;
				break;
			}
		}
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- same record with id-valued properties replaced
	return next as R;
}
