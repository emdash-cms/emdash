/**
 * Entry writer: rows of the dynamic `ec_*` content tables.
 *
 * Standard columns come from `CONTENT_TABLE_COLUMNS`, field columns from the
 * imported `_emdash_fields` rows. A row that needs more bound parameters than
 * one D1 statement allows is inserted with its standard columns first and
 * its field columns set by batched `UPDATE`s, after checking that the stored
 * standard columns are the importer's own.
 */

import type { Kysely } from "kysely";

import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { TransferError } from "../errors.js";
import {
	codecForColumnType,
	CONTENT_TABLE_COLUMNS,
	CONTENT_TABLE_PREFIX,
} from "../format/columns.js";
import type { ColumnCodec } from "../format/columns.js";
import type { EntryRecord } from "../format/kinds.js";
import { rowsPerInsert } from "../format/limits.js";
import { applyTransformations, type FieldColumnType } from "../format/transformations.js";
import { applyRewrittenIds, type ImportContext } from "./context.js";
import { ulidFromHash } from "./ids.js";
import { encodeRecord, encodeValue, firstDifference, recordCodecs, type Row } from "./rows.js";
import { estimateStatements, insertRows, selectByKeys, updateColumns } from "./sql.js";
import { assertRewritable, uniqueConflict, type WriteInput } from "./writers.js";

const STANDARD_CODECS = recordCodecs(CONTENT_TABLE_COLUMNS);
const STANDARD_COLUMNS = Object.keys(STANDARD_CODECS);

export function contentTable(collection: string): string {
	validateIdentifier(collection, "collection slug");
	return `${CONTENT_TABLE_PREFIX}${collection}`;
}

/** Statements for `count` entries of a collection with `fieldCount` fields. */
export function estimateEntryWrite(count: number, fieldCount: number): number {
	const columns = STANDARD_COLUMNS.length + fieldCount;
	if (rowsPerInsert(columns) === 0) {
		return count * (2 + Math.ceil(fieldCount / 99)) + Math.ceil(count / 100) + 3;
	}
	return estimateStatements(count, columns) + 3;
}

export async function writeEntries(
	context: ImportContext,
	inputs: ReadonlyArray<WriteInput<"entry">>,
): Promise<void> {
	const byCollection = new Map<string, Array<WriteInput<"entry">>>();
	for (const input of inputs) {
		const list = byCollection.get(input.record.collection) ?? [];
		list.push(input);
		byCollection.set(input.record.collection, list);
	}
	for (const [collection, group] of byCollection) {
		const fieldColumns = await context.fieldColumns(collection);
		const fieldColumnTypes = new Map([[collection, fieldColumns]]);
		const transformed = group.map((input) =>
			applyTransformations(input.record, context.plan, { fieldColumnTypes }),
		);
		const resolved = await context.resolveMediaRefs(
			transformed,
			group.map((input) => input.line),
		);
		await writeCollectionEntries(context, collection, fieldColumns, resolved, false);
	}
}

function fieldCodecs(
	fieldColumns: ReadonlyMap<string, FieldColumnType>,
): Record<string, ColumnCodec> {
	const codecs: Record<string, ColumnCodec> = {};
	for (const [slug, columnType] of fieldColumns) codecs[slug] = codecForColumnType(columnType);
	return codecs;
}

function entryRow(
	db: Kysely<Database>,
	record: EntryRecord,
	codecs: Readonly<Record<string, ColumnCodec>>,
	required: ReadonlySet<string>,
): Row {
	const row = encodeRecord(db, CONTENT_TABLE_COLUMNS, record, { kind: "entry", id: record.id });
	for (const slug of Object.keys(record.fields)) {
		if (!Object.hasOwn(codecs, slug)) {
			throw new TransferError("TRANSFER_RECORD_INVALID", "Entry has a field its collection lacks", {
				detail: { kind: "entry", id: record.id, field: slug },
			});
		}
	}
	for (const [slug, codec] of Object.entries(codecs)) {
		row[slug] = encodeValue(
			db,
			codec,
			record.fields[slug],
			{ kind: "entry", id: record.id, column: slug },
			{ notNull: required.has(slug) },
		);
	}
	return row;
}

async function writeCollectionEntries(
	context: ImportContext,
	collection: string,
	fieldColumns: ReadonlyMap<string, FieldColumnType>,
	records: readonly EntryRecord[],
	retry: boolean,
): Promise<void> {
	const table = contentTable(collection);
	const fields = fieldCodecs(fieldColumns);
	const required = await context.requiredFields(collection);
	const codecs = { ...STANDARD_CODECS, ...fields };
	const rewritten = await context.rewrittenIds("entry", records);
	const rows = records.map((record) =>
		entryRow(context.db, applyRewrittenIds(record, rewritten), fields, required),
	);
	const columns = Object.keys(codecs);
	const wide = rowsPerInsert(columns.length) === 0;

	const collisions = await withTransaction(context.db, async (trx) => {
		await insertRows(trx, table, wide ? STANDARD_COLUMNS : columns, rows);
		let stored = await storedById(trx, table, rows);
		if (wide) {
			const fieldSlugs = Object.keys(fields);
			for (const row of rows) {
				const existing = stored.get(String(row.id));
				if (
					!existing ||
					firstDifference(context.db, STANDARD_CODECS, row, existing, {
						float4: context.float4,
					}) !== null
				) {
					continue;
				}
				await updateColumns(trx, table, "id", String(row.id), row, fieldSlugs);
			}
			stored = await storedById(trx, table, rows);
		}

		const found: EntryRecord[] = [];
		rows.forEach((row, index) => {
			const record = records[index];
			if (!record) return;
			const existing = stored.get(String(row.id));
			if (!existing) throw uniqueConflict("entry", record.id);
			const column = firstDifference(context.db, codecs, row, existing, {
				float4: context.float4,
			});
			if (column === null) return;
			assertRewritable(context, {
				kind: "entry",
				id: record.id,
				column,
				idKeyed: true,
				rewritten: retry || rewritten.has(`entry\u0000${record.id}`),
			});
			found.push(record);
		});
		return found;
	});
	if (collisions.length === 0) return;

	const mappings = await Promise.all(
		collisions.map(async (record) => ({
			portableId: record.id,
			targetId: await ulidFromHash(context.operationId, "entry", record.id),
		})),
	);
	await context.identity.putMany("entry", mappings);
	context.noteRewrite("entry");
	await writeCollectionEntries(context, collection, fieldColumns, collisions, true);
}

async function storedById(
	db: Kysely<Database>,
	table: string,
	rows: readonly Row[],
): Promise<Map<string, Row>> {
	const stored = await selectByKeys(db, table, ["id"], rows);
	return new Map(stored.map((row) => [String(row.id), row]));
}
