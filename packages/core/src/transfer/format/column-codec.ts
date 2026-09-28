/**
 * The single decoding and encoding path between database column values and
 * record property values. Exporter readers, verification, and importer
 * writers must all go through these functions so a value read on one dialect
 * and written on another round-trips to the same record value.
 *
 * Rules:
 * - SQL `NULL` decodes to `undefined` (the property is omitted) and
 *   `undefined`/`null` encode to `NULL`.
 * - `boolean`: 0/1 integers ↔ booleans (any non-zero number decodes to true).
 * - `integer`: numbers, and Postgres `bigint` strings, decode to numbers when
 *   they are safe integers. Any other value (non-numeric text a SQLite column
 *   may hold) decodes to itself.
 * - `real`: numbers. On Postgres, `real` is float4 and node-pg renders it
 *   with float4 precision (`0.1`), which differs from the float4 value itself
 *   (`Math.fround(0.1)`). Select REAL columns with {@link selectColumn}, which
 *   casts to float8 on Postgres, so the decoded number is exactly the stored
 *   float4 value.
 * - `json` (JSON held in a TEXT column): the parsed value; text that is not
 *   valid JSON decodes to the text itself. Encoding always writes
 *   `JSON.stringify`, so raw text that is not JSON is stored as a JSON
 *   string: EmDash parses these columns as JSON when it reads them.
 * - `nativeJson` (a column declared `json`: `ec_*` JSON fields): on
 *   Postgres, node-pg returns the parsed value; on SQLite the column has
 *   NUMERIC affinity, so numbers come back as numbers and everything else as
 *   text decoded like `json`. Encoding on Postgres is always
 *   `JSON.stringify`; on SQLite numbers are written as numbers and the rest
 *   like `json`.
 * - `text`: strings verbatim.
 * - A JSON `null` decodes like SQL `NULL` (absent): node-pg cannot tell them
 *   apart in a `json` column, so neither dialect does. A NOT NULL JSON
 *   column can only hold JSON `null` for an absent value, so encoding for
 *   one (`notNull`) writes JSON `null`.
 *
 * Invariant: for every value `v` produced by `decodeColumn`,
 * `decodeColumn(encodeColumn(v))` on either dialect yields `v`.
 */

import { sql, type AliasedRawBuilder, type Kysely } from "kysely";

import { detectDialect, type DatabaseDialectType } from "../../database/dialect-helpers.js";
import { TransferError } from "../errors.js";
import type { ColumnCodec, ColumnSpec } from "./columns.js";
import { CONTENT_TABLE_COLUMNS } from "./columns.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
type DialectSource = DatabaseDialectType | Kysely<any>;

const SAFE_INTEGER_TEXT = /^-?\d+$/;

function dialectOf(source: DialectSource): DatabaseDialectType {
	return typeof source === "string" ? source : detectDialect(source);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function invalid(codec: ColumnCodec, reason: string): TransferError {
	return new TransferError("TRANSFER_RECORD_INVALID", "Value cannot be stored in its column", {
		detail: { codec, reason },
	});
}

/** Decode one raw column value. Returns `undefined` for SQL `NULL`. */
export function decodeColumn(source: DialectSource, codec: ColumnCodec, raw: unknown): unknown {
	if (raw === null || raw === undefined) return undefined;
	const dialect = dialectOf(source);
	switch (codec) {
		case "text":
			return raw;
		case "boolean":
			if (typeof raw === "number") return raw !== 0;
			if (typeof raw === "bigint") return raw !== 0n;
			if (typeof raw === "string" && SAFE_INTEGER_TEXT.test(raw)) return Number(raw) !== 0;
			if (typeof raw === "boolean") return raw;
			return raw;
		case "integer":
			if (typeof raw === "bigint")
				return Number.isSafeInteger(Number(raw)) ? Number(raw) : String(raw);
			if (typeof raw === "string" && SAFE_INTEGER_TEXT.test(raw)) {
				const value = Number(raw);
				return Number.isSafeInteger(value) ? value : raw;
			}
			return raw;
		case "real":
			if (typeof raw === "string" && dialect === "postgres") return Number(raw);
			return raw;
		case "json":
			if (typeof raw !== "string") return raw;
			return decodeJsonText(raw);
		case "nativeJson":
			if (dialect === "postgres") return raw;
			if (typeof raw !== "string") return raw;
			return decodeJsonText(raw);
	}
}

function decodeJsonText(text: string): unknown {
	const parsed = tryParseJson(text);
	if (!parsed.ok) return text;
	return parsed.value === null ? undefined : parsed.value;
}

/**
 * Encode one record value for a column. Returns `null` for an absent value,
 * or JSON `null` when `notNull` is set for a JSON column.
 */
export function encodeColumn(
	source: DialectSource,
	codec: ColumnCodec,
	value: unknown,
	options: { notNull?: boolean } = {},
): unknown {
	if (value === undefined || value === null) {
		return options.notNull && (codec === "json" || codec === "nativeJson") ? "null" : null;
	}
	const dialect = dialectOf(source);
	switch (codec) {
		case "text":
			if (typeof value !== "string") throw invalid(codec, "expected a string");
			return value;
		case "boolean":
			if (typeof value !== "boolean") throw invalid(codec, "expected a boolean");
			return value ? 1 : 0;
		case "integer":
			if (typeof value === "number") {
				if (!Number.isSafeInteger(value)) throw invalid(codec, "expected an integer");
				return value;
			}
			if (typeof value === "string" && dialect === "sqlite") return value;
			throw invalid(codec, "expected an integer");
		case "real":
			if (typeof value === "number") {
				if (!Number.isFinite(value)) throw invalid(codec, "expected a finite number");
				return value;
			}
			if (typeof value === "string" && dialect === "sqlite") return value;
			throw invalid(codec, "expected a number");
		case "json":
			return encodeJsonText(value);
		case "nativeJson":
			if (dialect === "postgres") return JSON.stringify(value);
			if (typeof value === "number") return value;
			return encodeJsonText(value);
	}
}

function encodeJsonText(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw invalid("json", "value is not JSON");
	return text;
}

/**
 * Select expression for a column, aliased to the column name. REAL columns
 * are cast to float8 on Postgres (see the module comment).
 */
export function selectColumn(
	source: DialectSource,
	column: string,
	codec: ColumnCodec,
): AliasedRawBuilder<unknown, string> {
	if (codec === "real" && dialectOf(source) === "postgres") {
		return sql`${sql.ref(column)}::float8`.as(column);
	}
	return sql`${sql.ref(column)}`.as(column);
}

function propertyOf(spec: ColumnSpec): { property: string; codec: ColumnCodec } | null {
	return "property" in spec ? { property: spec.property, codec: spec.codec } : null;
}

/**
 * Select expressions for every exported column of a table (columns whose
 * class has a property), in `specs` order.
 */
export function selectExportedColumns(
	source: DialectSource,
	specs: Readonly<Record<string, ColumnSpec>>,
): AliasedRawBuilder<unknown, string>[] {
	const expressions: AliasedRawBuilder<unknown, string>[] = [];
	for (const [column, spec] of Object.entries(specs)) {
		const mapped = propertyOf(spec);
		if (mapped) expressions.push(selectColumn(source, column, mapped.codec));
	}
	return expressions;
}

/** Decode a row into record properties; NULL columns are omitted. */
export function decodeRow(
	source: DialectSource,
	specs: Readonly<Record<string, ColumnSpec>>,
	row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const dialect = dialectOf(source);
	const properties: Record<string, unknown> = {};
	for (const [column, spec] of Object.entries(specs)) {
		const mapped = propertyOf(spec);
		if (!mapped || !Object.hasOwn(row, column)) continue;
		const value = decodeColumn(dialect, mapped.codec, row[column]);
		if (value !== undefined) properties[mapped.property] = value;
	}
	return properties;
}

/**
 * Encode record properties into column values for every exported column of
 * `specs`. Absent properties become `NULL`. Columns of other classes are not
 * included; writers fill those themselves.
 */
export function encodeRow(
	source: DialectSource,
	specs: Readonly<Record<string, ColumnSpec>>,
	properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const dialect = dialectOf(source);
	const row: Record<string, unknown> = {};
	for (const [column, spec] of Object.entries(specs)) {
		const mapped = propertyOf(spec);
		if (!mapped) continue;
		row[column] = encodeColumn(
			dialect,
			mapped.codec,
			Object.hasOwn(properties, mapped.property) ? properties[mapped.property] : undefined,
		);
	}
	return row;
}

/** Whether an `ec_*` column is a field column rather than a standard column. */
export function isContentFieldColumn(column: string): boolean {
	return !Object.hasOwn(CONTENT_TABLE_COLUMNS, column);
}

/**
 * Decode an `ec_*` row into the standard entry properties and the `fields`
 * map (field slug → value). `specs` comes from `getColumnSpecs`.
 */
export function decodeContentRow(
	source: DialectSource,
	specs: Readonly<Record<string, ColumnSpec>>,
	row: Readonly<Record<string, unknown>>,
): { properties: Record<string, unknown>; fields: Record<string, unknown> } {
	const standard: Record<string, ColumnSpec> = {};
	const fieldSpecs: Record<string, ColumnSpec> = {};
	for (const [column, spec] of Object.entries(specs)) {
		if (isContentFieldColumn(column)) fieldSpecs[column] = spec;
		else standard[column] = spec;
	}
	return {
		properties: decodeRow(source, standard, row),
		fields: decodeRow(source, fieldSpecs, row),
	};
}

/** Inverse of {@link decodeContentRow}. */
export function encodeContentRow(
	source: DialectSource,
	specs: Readonly<Record<string, ColumnSpec>>,
	properties: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const standard: Record<string, ColumnSpec> = {};
	const fieldSpecs: Record<string, ColumnSpec> = {};
	for (const [column, spec] of Object.entries(specs)) {
		if (isContentFieldColumn(column)) fieldSpecs[column] = spec;
		else standard[column] = spec;
	}
	return { ...encodeRow(source, standard, properties), ...encodeRow(source, fieldSpecs, fields) };
}
