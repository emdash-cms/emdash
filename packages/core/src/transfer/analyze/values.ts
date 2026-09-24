/**
 * Per-record value checks: media placeholders and external media providers
 * inside record values, and the constraints a target database puts on stored
 * values (column types, NOT NULL, Postgres int4 / float4).
 */

import { isTransferError } from "../errors.js";
import { measureJsonDepth } from "../format/canonical.js";
import { encodeColumn } from "../format/column-codec.js";
import { codecForColumnType } from "../format/columns.js";
import { identityProperties, type EntryRecord, type SitePackageRecord } from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import { PLACEHOLDER_TOKEN } from "../format/media-refs.js";
import type { PlanBlockerCode } from "../format/plan.js";
import type { FieldColumnType } from "../format/transformations.js";

export type TargetDialect = "sqlite" | "postgres";

export interface FieldInfo {
	columnType: FieldColumnType;
	required: boolean;
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reported in place of a provider id that is not a plain identifier. */
export const OTHER_PROVIDER = "other";

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

/**
 * Top-level record properties stored in JSON (or JSON-shaped) columns. Numbers
 * directly under them are JSON numbers, not integer columns.
 */
const JSON_PROPERTIES: ReadonlySet<string> = new Set([
	"adminConfig",
	"componentProps",
	"content",
	"data",
	"defaultValue",
	"fields",
	"keywords",
	"moderationMetadata",
	"options",
	"searchConfig",
	"validation",
	"value",
]);

/** Top-level properties stored in REAL columns. */
const REAL_PROPERTIES: ReadonlySet<string> = new Set(["focalX", "focalY"]);

export interface RecordScan {
	/** Media ids named by `emdash-media:` placeholders. */
	placeholders: Set<string>;
	/** `emdash-media:` occurrences that are neither a placeholder nor an escape. */
	malformed: number;
	/** Media values whose provider is not local, by provider id. */
	providers: Map<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEmbeddedJson(value: string): unknown {
	const trimmed = value.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	if (measureJsonDepth(value) > TRANSFER_LIMITS.jsonDepth) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function scanValue(value: unknown, scan: RecordScan, embedded: boolean): void {
	if (typeof value === "string") {
		if (!embedded) {
			for (const match of value.matchAll(PLACEHOLDER_TOKEN)) {
				if (match[2] !== undefined) scan.placeholders.add(match[2]);
				else if (match[1] === undefined) scan.malformed++;
			}
			const parsed = parseEmbeddedJson(value);
			if (parsed !== undefined) scanValue(parsed, scan, true);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) scanValue(item, scan, embedded);
		return;
	}
	if (!isPlainObject(value)) return;
	const provider = value.provider;
	if (typeof provider === "string" && provider !== "local" && typeof value.id === "string") {
		const key = PROVIDER_ID_PATTERN.test(provider) ? provider : OTHER_PROVIDER;
		scan.providers.set(key, (scan.providers.get(key) ?? 0) + 1);
	}
	for (const child of Object.values(value)) scanValue(child, scan, embedded);
}

/**
 * Placeholders and external media values in every non-identity property of a
 * record. Placeholders are read from each string as text, the way the
 * importer resolves them, never from JSON parsed out of a string.
 */
export function scanRecordValues(record: SitePackageRecord): RecordScan {
	const scan: RecordScan = { placeholders: new Set(), malformed: 0, providers: new Map() };
	const skip = identityProperties(record.kind);
	for (const [property, value] of Object.entries(record)) {
		if (!skip.has(property)) scanValue(value, scan, false);
	}
	return scan;
}

export interface ValueIssue {
	code: Extract<PlanBlockerCode, "integer_out_of_range" | "value_constraint_violation">;
	message: string;
	property: string;
	field?: string;
}

export interface ValueCheckResult {
	issues: ValueIssue[];
	/** Values a float4 column would store differently. */
	float4Rounded: number;
}

function isInt4(value: number): boolean {
	return value >= INT4_MIN && value <= INT4_MAX;
}

function roundsInFloat4(value: number): boolean {
	return Math.fround(value) !== value;
}

/**
 * Top-level integer and real properties of any record against a Postgres
 * target, where `integer` is int4 and `real` is float4.
 */
export function checkRecordNumbers(
	record: SitePackageRecord,
	dialect: TargetDialect,
): ValueCheckResult {
	const result: ValueCheckResult = { issues: [], float4Rounded: 0 };
	if (dialect !== "postgres") return result;
	for (const [property, value] of Object.entries(record)) {
		if (typeof value !== "number" || JSON_PROPERTIES.has(property)) continue;
		if (REAL_PROPERTIES.has(property)) {
			if (roundsInFloat4(value)) result.float4Rounded++;
		} else if (!isInt4(value)) {
			result.issues.push({
				code: "integer_out_of_range",
				message: "Integer is outside the target database's integer range",
				property,
			});
		}
	}
	return result;
}

function mismatch(field: string, message: string): ValueIssue {
	return { code: "value_constraint_violation", message, property: "fields", field };
}

/**
 * Entry field values against the target column each field is stored in,
 * through the shared column codec: a value the codec cannot encode for the
 * column is an issue, as is a missing value in a NOT NULL (required) column
 * other than a JSON one (which stores it as JSON `null`) and, on Postgres,
 * an integer outside int4. Boolean fields are INTEGER
 * columns, so their values are 0/1 numbers.
 */
export function checkEntryFields(
	entry: EntryRecord,
	fields: ReadonlyMap<string, FieldInfo>,
	dialect: TargetDialect,
): ValueCheckResult {
	const result: ValueCheckResult = { issues: [], float4Rounded: 0 };
	for (const [slug, value] of Object.entries(entry.fields)) {
		const info = fields.get(slug);
		if (!info) {
			result.issues.push(mismatch(slug, "Entry has a value for a field its collection lacks"));
			continue;
		}
		try {
			encodeColumn(dialect, codecForColumnType(info.columnType), value);
		} catch (error) {
			if (!isTransferError(error)) throw error;
			result.issues.push(mismatch(slug, "Value does not fit the field's column type"));
			continue;
		}
		if (dialect !== "postgres" || typeof value !== "number") continue;
		if (info.columnType === "INTEGER" && !isInt4(value)) {
			result.issues.push({
				code: "integer_out_of_range",
				message: "Integer is outside the target database's integer range",
				property: "fields",
				field: slug,
			});
		} else if (info.columnType === "REAL" && roundsInFloat4(value)) {
			result.float4Rounded++;
		}
	}
	for (const [slug, info] of fields) {
		if (info.required && info.columnType !== "JSON" && !Object.hasOwn(entry.fields, slug)) {
			result.issues.push(mismatch(slug, "Required field has no value"));
		}
	}
	return result;
}

/** Kinds whose records carry a `locale`. */
export function recordLocale(record: SitePackageRecord): string | undefined {
	const locale: unknown = Reflect.get(record, "locale");
	return typeof locale === "string" ? locale : undefined;
}

export function recordStringProperty(
	record: SitePackageRecord,
	property: string,
): string | undefined {
	if (!Object.hasOwn(record, property)) return undefined;
	const value: unknown = Reflect.get(record, property);
	return typeof value === "string" ? value : undefined;
}
