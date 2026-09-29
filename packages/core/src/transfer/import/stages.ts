/**
 * The record stages of an import: each walks its kinds' package streams in
 * order and writes them in bounded units, checkpointing the stream position
 * after every unit.
 */

import { sql } from "kysely";

import { SchemaError, SchemaRegistry } from "../../schema/registry.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { TransferError } from "../errors.js";
import {
	IMPORT_STAGE_KINDS,
	inferredCreditId,
	type ContentBylineRecord,
	type EntryRecord,
	type ImportRecordStage,
	type RecordKind,
	type RecordOfKind,
} from "../format/kinds.js";
import type { StreamPosition } from "../ops/states.js";
import type { StagedRecord } from "../staging/package.js";
import { applyRewrittenIds, type ImportContext } from "./context.js";
import { estimateEntryWrite, writeEntries } from "./entries.js";
import { blobBytes, MEDIA_ROW_STATEMENTS, writeMedia } from "./media.js";
import { estimateWrite, isFlatKind, writeRecords, type WriteInput } from "./writers.js";

/** Identity-map kind linking an unmapped principal's byline, per locale, to its group. */
export const PRINCIPAL_BYLINE_ENTITY = "principal_byline";

/**
 * Identity-map kind recording each materialized inferred credit: the
 * `content_byline` row id (`inferredCreditId`) mapped to its byline group.
 * Only these rows are materialized credits; a package's own `inferred:` rows
 * are explicit credits like any other.
 */
export const INFERRED_CREDIT_ENTITY = "inferred_credit";

/**
 * Streams walked by each record stage. Fields are written together with
 * their collection. The relations stage walks the entry stream a second
 * time, after explicit credits exist, to materialize inferred credits.
 */
export const STAGE_STREAMS: Readonly<Record<ImportRecordStage, readonly RecordKind[]>> = {
	...IMPORT_STAGE_KINDS,
	schema: IMPORT_STAGE_KINDS.schema.filter((kind) => kind !== "field"),
	relations: IMPORT_STAGE_KINDS.relations.flatMap((kind): RecordKind[] =>
		kind === "content_byline" ? [kind, "entry"] : [kind],
	),
};

const DEFAULT_BATCH = 100;
const ENTRY_BATCH = 50;
const COLLECTION_STATEMENTS = 80;

/** Thrown out of a stage when the operation was asked to cancel. */
export class ImportCancelledSignal extends Error {}

export type Checkpoint = (position: StreamPosition) => Promise<void>;

export function firstPosition(stage: ImportRecordStage): StreamPosition {
	const kind = STAGE_STREAMS[stage][0];
	if (!kind) throw new Error(`Stage ${stage} has no streams`);
	return { kind, seq: 0, line: 0 };
}

/**
 * Run units of `stage` from `position` until the stage is done (returns
 * null) or the step budget is spent (returns the next position).
 */
export async function runRecordStage(
	context: ImportContext,
	stage: ImportRecordStage,
	start: StreamPosition,
	checkpoint: Checkpoint,
): Promise<StreamPosition | null> {
	const streams = STAGE_STREAMS[stage];
	let position: StreamPosition | null = start;
	while (position) {
		const kindIndex = streams.indexOf(position.kind);
		if (kindIndex === -1) {
			throw new TransferError("TRANSFER_INVALID_STATE", "Import cursor names an unknown stream");
		}
		if (position.seq >= context.chunkCount(position.kind)) {
			const next = streams[kindIndex + 1];
			position = next ? { kind: next, seq: 0, line: 0 } : null;
			continue;
		}
		const chunk = await context.chunk(position.kind, position.seq);
		if (position.line >= chunk.length) {
			position = { kind: position.kind, seq: position.seq + 1, line: 0 };
			continue;
		}
		const unit = await planUnit(context, stage, position, chunk);
		if (!context.budget.canStart({ queries: unit.queries + 3, bytes: unit.bytes })) {
			return position;
		}
		context.budget.start(unit.bytes);
		await context.beginUnit(stage, position);
		await unit.run();
		const line = position.line + unit.count;
		position =
			line >= chunk.length
				? { kind: position.kind, seq: position.seq + 1, line: 0 }
				: { kind: position.kind, seq: position.seq, line };
		await checkpoint(position);
	}
	return null;
}

interface Unit {
	count: number;
	queries: number;
	bytes: number;
	run: () => Promise<void>;
}

async function planUnit(
	context: ImportContext,
	stage: ImportRecordStage,
	position: StreamPosition,
	chunk: ReadonlyArray<StagedRecord<RecordKind>>,
): Promise<Unit> {
	const kind = position.kind;
	const rest = chunk.slice(position.line);

	if (kind === "collection") {
		const [staged] = rest;
		if (!staged || staged.record.kind !== "collection") throw new Error("Expected a collection");
		const record = staged.record;
		return {
			count: 1,
			queries: COLLECTION_STATEMENTS,
			bytes: 0,
			run: () => importCollection(context, record),
		};
	}

	if (kind === "media") {
		const [staged] = rest;
		if (!staged || staged.record.kind !== "media") throw new Error("Expected a media record");
		const input = { record: staged.record, line: staged.line };
		const bytes = await blobBytes(context, staged.record);
		return {
			count: 1,
			queries: MEDIA_ROW_STATEMENTS,
			bytes,
			run: () => writeMedia(context, input, bytes),
		};
	}

	if (kind === "entry") {
		const batch = inputsOf("entry", rest.slice(0, ENTRY_BATCH));
		if (stage === "relations") {
			return {
				count: batch.length,
				queries:
					4 +
					Math.ceil(batch.length / SQL_BATCH_SIZE) * 2 +
					estimateWrite("content_byline", batch.length),
				bytes: 0,
				run: () => materializeInferredCredits(context, batch),
			};
		}
		let queries = 3;
		const perCollection = new Map<string, number>();
		for (const input of batch) {
			perCollection.set(
				input.record.collection,
				(perCollection.get(input.record.collection) ?? 0) + 1,
			);
		}
		for (const [collection, count] of perCollection) {
			const fields = await context.fieldColumns(collection);
			queries += estimateEntryWrite(count, fields.size);
		}
		return { count: batch.length, queries, bytes: 0, run: () => writeEntries(context, batch) };
	}

	if (!isFlatKind(kind)) {
		throw new TransferError("TRANSFER_INVALID_STATE", "Import cursor names an unknown stream");
	}
	const batch = rest.slice(0, DEFAULT_BATCH);
	return {
		count: batch.length,
		queries: estimateWrite(kind, batch.length),
		bytes: 0,
		run: async () => {
			const inputs = batch.map((staged) => ({ record: staged.record, line: staged.line }));
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- records of one chunk share its kind
			await writeRecords(context, kind, inputs as Array<WriteInput<typeof kind>>);
			if (kind === "byline") {
				await recordUnmappedBylines(context, inputsOf("byline", batch));
			}
		},
	};
}

function inputsOf<K extends RecordKind>(
	kind: K,
	staged: ReadonlyArray<StagedRecord<RecordKind>>,
): Array<WriteInput<K>> {
	return staged.map((item) => {
		if (item.record.kind !== kind) throw new Error(`Expected ${kind} records`);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- kind checked above
		return { record: item.record as RecordOfKind<K>, line: item.line };
	});
}

async function importCollection(
	context: ImportContext,
	record: RecordOfKind<"collection">,
): Promise<void> {
	const fields = (await context.allRecords("field")).filter(
		(field) => field.collectionId === record.id,
	);
	try {
		await new SchemaRegistry(context.db).importCollection(record, fields, { resume: true });
	} catch (error) {
		if (error instanceof SchemaError) {
			throw new TransferError("TRANSFER_IMPORT_ERROR", "Collection could not be imported", {
				detail: { kind: "collection", id: record.id, reason: error.code },
				cause: error,
			});
		}
		throw error;
	}
}

/**
 * Remember which byline an unmapped principal owns in each locale, so the
 * relations stage can keep that principal's inferred author credits.
 */
async function recordUnmappedBylines(
	context: ImportContext,
	inputs: ReadonlyArray<WriteInput<"byline">>,
): Promise<void> {
	const mappings = inputs.flatMap(({ record }) =>
		record.userPrincipal !== undefined && context.principalTarget(record.userPrincipal) === null
			? [
					{
						portableId: `${record.locale}:${record.userPrincipal}`,
						targetId: record.translationGroup ?? record.id,
					},
				]
			: [],
	);
	await context.identity.putMany(PRINCIPAL_BYLINE_ENTITY, mappings);
}

/**
 * Explicit `content_byline` rows for entries whose author credit would
 * otherwise be inferred from an unmapped principal and vanish on the target:
 * the author is unmapped, the entry has no explicit credit, and the author
 * has a byline in the entry's locale.
 */
async function materializeInferredCredits(
	context: ImportContext,
	inputs: ReadonlyArray<WriteInput<"entry">>,
): Promise<void> {
	const candidates = inputs
		.map((input) => input.record)
		.filter(
			(record): record is EntryRecord & { authorPrincipal: string } =>
				record.authorPrincipal !== undefined &&
				record.primaryBylineGroup === undefined &&
				context.principalTarget(record.authorPrincipal) === null,
		);
	if (candidates.length === 0) return;
	const groups = await context.identity.getMany(
		PRINCIPAL_BYLINE_ENTITY,
		candidates.map((record) => `${record.locale}:${record.authorPrincipal}`),
	);
	const credited = candidates.filter((record) =>
		groups.has(`${record.locale}:${record.authorPrincipal}`),
	);
	if (credited.length === 0) return;

	const rewritten = await context.rewrittenIds("entry", credited);
	const targetIds = credited.map((record) => applyRewrittenIds(record, rewritten).id);
	const explicit = new Set<string>();
	for (const batch of chunks(targetIds, SQL_BATCH_SIZE)) {
		const rows = await context.db
			.selectFrom("_emdash_content_bylines")
			.select(["collection_slug", "content_id"])
			.where("content_id", "in", batch)
			.where(({ exists, not, selectFrom }) =>
				not(
					exists(
						selectFrom("_emdash_transfer_identity_map")
							.select(sql`1`.as("one"))
							.where("_emdash_transfer_identity_map.operation_id", "=", context.operationId)
							.where("_emdash_transfer_identity_map.entity_kind", "=", INFERRED_CREDIT_ENTITY)
							.whereRef(
								"_emdash_transfer_identity_map.portable_id",
								"=",
								"_emdash_content_bylines.id",
							),
					),
				),
			)
			.execute();
		for (const row of rows) explicit.add(`${row.collection_slug}\u0000${row.content_id}`);
	}

	const credits: Array<WriteInput<"content_byline">> = [];
	credited.forEach((record, index) => {
		if (explicit.has(`${record.collection}\u0000${targetIds[index]}`)) return;
		const bylineGroup = groups.get(`${record.locale}:${record.authorPrincipal}`);
		if (bylineGroup === undefined) return;
		const credit: ContentBylineRecord = {
			kind: "content_byline",
			id: inferredCreditId(record.collection, record.id),
			collection: record.collection,
			entryId: record.id,
			bylineGroup,
			sortOrder: 0,
			...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
		};
		credits.push({ record: credit, line: "" });
	});
	if (credits.length === 0) return;
	// Recorded before writing: a resumed unit must still see a written credit as materialized.
	await context.identity.putMany(
		INFERRED_CREDIT_ENTITY,
		credits.map(({ record }) => ({ portableId: record.id, targetId: record.bylineGroup })),
	);
	await writeRecords(context, "content_byline", credits);
}
