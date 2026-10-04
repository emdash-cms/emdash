/**
 * Record ↔ row helpers for the importer over the shared column codec
 * (`format/column-codec.ts`).
 *
 * Stored rows are compared with the rows the importer meant to write after
 * decoding both sides with the same codec, so dialect differences (Postgres
 * `json` columns returning parsed values, `bigint` strings) do not register as
 * mismatches. Postgres stores REAL columns as float4, so REAL values are
 * compared after `Math.fround` there.
 */

import type { Kysely } from "kysely";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";
import { isTransferError, TransferError } from "../errors.js";
import { canonicalJson } from "../format/canonical.js";
import { decodeColumn, encodeColumn } from "../format/column-codec.js";
import type { ColumnCodec, ColumnSpec } from "../format/columns.js";

export type Row = Record<string, unknown>;

/** Codec per column, for the columns a comparison covers. */
export type RowCodecs = Readonly<Record<string, ColumnCodec>>;

/** Codecs of the columns a record carries (`field`, `principal`, `mediaRef`). */
export function recordCodecs(columns: Readonly<Record<string, ColumnSpec>>): RowCodecs {
	const codecs: Record<string, ColumnCodec> = {};
	for (const [column, spec] of Object.entries(columns)) {
		if ("property" in spec) codecs[column] = spec.codec;
	}
	return codecs;
}

/**
 * The row for `record` over every column the record carries. `record` must
 * already be in target form: placeholders resolved and principals mapped.
 */
export function encodeRecord(
	db: Kysely<Database>,
	columns: Readonly<Record<string, ColumnSpec>>,
	record: Readonly<Record<string, unknown>>,
	location: { kind: string; id: string },
): Row {
	const row: Row = {};
	for (const [column, spec] of Object.entries(columns)) {
		if (!("property" in spec)) continue;
		row[column] = encodeValue(
			db,
			spec.codec,
			Object.hasOwn(record, spec.property) ? record[spec.property] : undefined,
			{ ...location, column },
		);
	}
	return row;
}

/** `encodeColumn`, with the record and column named in a failure. */
export function encodeValue(
	db: Kysely<Database>,
	codec: ColumnCodec,
	value: unknown,
	location: { kind: string; id: string; column: string },
	options: { notNull?: boolean } = {},
): unknown {
	try {
		return encodeColumn(db, codec, value, options);
	} catch (error) {
		if (!isTransferError(error)) throw error;
		throw new TransferError(error.code, "Record value does not fit its target column", {
			detail: { ...location, ...error.detail },
			cause: error,
		});
	}
}

function comparable(
	db: Kysely<Database>,
	codec: ColumnCodec,
	raw: unknown,
	options: { float4: boolean; encoded: boolean },
): string | undefined {
	const stored =
		options.encoded && codec === "nativeJson" && isPostgres(db) && typeof raw === "string"
			? JSON.parse(raw)
			: raw;
	const value = decodeColumn(db, codec, stored);
	if (value === undefined) return undefined;
	if (options.float4 && codec === "real" && typeof value === "number") {
		return canonicalJson(Math.fround(value));
	}
	return canonicalJson(value);
}

/**
 * The first column (in `codecs` order) where the stored row differs from the
 * row the importer encoded, or null when they are equal over those columns.
 * Postgres returns `json` columns parsed, so an encoded `nativeJson` value is
 * parsed before it is compared.
 */
export function firstDifference(
	db: Kysely<Database>,
	codecs: RowCodecs,
	encoded: Row,
	stored: Row,
	options: { float4: boolean },
): string | null {
	for (const [column, codec] of Object.entries(codecs)) {
		const want = comparable(db, codec, encoded[column], { ...options, encoded: true });
		const have = comparable(db, codec, stored[column], { ...options, encoded: false });
		if (want !== have) return column;
	}
	return null;
}
