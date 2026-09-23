import { PostgresAdapter, sql, type Kysely } from "kysely";

import {
	DatetimeNormalizationError,
	normalizeContentDatetimes,
	normalizeDatetime,
	type DatetimeFieldDescriptor,
} from "../datetime-normalization.js";
import type { Database } from "./types.js";
import { validateIdentifier } from "./validate.js";

const SYSTEM_DATETIME_COLUMNS = [
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
] as const;
const MAX_DIAGNOSTIC_SAMPLES = 50;
const DATETIME_MIGRATION_BATCH_SIZE = 50;
const DATETIME_UPDATE_COLUMN_BATCH_SIZE = Math.floor((DATETIME_MIGRATION_BATCH_SIZE - 1) / 2);

interface CollectionDatetimeSchema {
	slug: string;
	fields: DatetimeFieldDescriptor[];
}

export interface DatetimeStorageSample {
	location: string;
	value: unknown;
	kind: "offset" | "naive" | "manual_review" | "inspection_error";
	message?: string;
}

export interface DatetimeStorageReport {
	timezone: string;
	noncanonicalCount: number;
	naiveCount: number;
	manualReviewCount: number;
	inspectionErrorCount: number;
	samples: DatetimeStorageSample[];
}

interface ScanState extends DatetimeStorageReport {
	write: boolean;
}

interface DatetimeColumnChange {
	before: unknown;
	after: unknown;
	json: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedJson(value: unknown): string {
	if (typeof value === "string") return value;
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Could not serialize repeater datetime data");
	return serialized;
}

function addSample(state: ScanState, sample: DatetimeStorageSample): void {
	if (state.samples.length < MAX_DIAGNOSTIC_SAMPLES) {
		state.samples.push(sample);
		return;
	}
	if (sample.kind !== "manual_review" && sample.kind !== "inspection_error") return;
	const replace = state.samples.findIndex(
		(existing) => existing.kind !== "manual_review" && existing.kind !== "inspection_error",
	);
	if (replace !== -1) state.samples[replace] = sample;
}

function parseRepeaterDatetimeFields(validation: string | null): string[] {
	if (!validation) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(validation);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || !("subFields" in parsed)) return [];
	const subFields = (parsed as { subFields?: unknown }).subFields;
	if (!Array.isArray(subFields)) return [];
	return subFields.flatMap((field) =>
		typeof field === "object" &&
		field !== null &&
		"type" in field &&
		field.type === "datetime" &&
		"slug" in field &&
		typeof field.slug === "string"
			? [field.slug]
			: [],
	);
}

async function loadSiteTimezone(db: Kysely<Database>): Promise<string> {
	const row = await db
		.selectFrom("options")
		.select("value")
		.where("name", "=", "site:timezone")
		.executeTakeFirst();
	if (!row) return "UTC";
	try {
		const value: unknown = JSON.parse(row.value);
		return typeof value === "string" && value ? value : "UTC";
	} catch {
		return "UTC";
	}
}

async function loadCollectionSchemas(
	db: Kysely<Database>,
): Promise<Map<string, CollectionDatetimeSchema>> {
	const collections = await db
		.selectFrom("_emdash_collections")
		.select(["id", "slug"])
		.orderBy("slug")
		.execute();
	const schemas = new Map<string, CollectionDatetimeSchema>(
		collections.map((collection) => [collection.slug, { slug: collection.slug, fields: [] }]),
	);
	const schemaBatchSize = DATETIME_MIGRATION_BATCH_SIZE - 2;
	for (let offset = 0; offset < collections.length; offset += schemaBatchSize) {
		const ids = collections
			.slice(offset, offset + schemaBatchSize)
			.map((collection) => collection.id);
		if (ids.length === 0) continue;
		const fields = await db
			.selectFrom("_emdash_fields as field")
			.innerJoin("_emdash_collections as collection", "collection.id", "field.collection_id")
			.select(["collection.slug as collection", "field.slug", "field.type", "field.validation"])
			.where("field.collection_id", "in", ids)
			.where("field.type", "in", ["datetime", "repeater"])
			.orderBy("field.id")
			.execute();
		for (const field of fields) {
			const schema = schemas.get(field.collection);
			if (!schema) continue;
			schema.fields.push(
				field.type === "datetime"
					? { slug: field.slug, type: "datetime" }
					: {
							slug: field.slug,
							type: "repeater",
							datetimeSubFields: parseRepeaterDatetimeFields(field.validation),
						},
			);
		}
	}
	return schemas;
}

function recordNormalization(
	state: ScanState,
	location: string,
	original: unknown,
	normalized: ReturnType<typeof normalizeDatetime>,
): void {
	if (normalized.kind === "canonical") return;
	state.noncanonicalCount++;
	if (normalized.kind === "naive") state.naiveCount++;
	addSample(state, { location, value: original, kind: normalized.kind });
}

function recordError(state: ScanState, location: string, value: unknown, error: unknown): void {
	if (
		error instanceof DatetimeNormalizationError &&
		(error.code === "ambiguous" || error.code === "nonexistent")
	) {
		state.manualReviewCount++;
		addSample(state, {
			location,
			value,
			kind: "manual_review",
			message: error.message,
		});
		return;
	}
	state.inspectionErrorCount++;
	addSample(state, {
		location,
		value,
		kind: "inspection_error",
		message: error instanceof Error ? error.message : String(error),
	});
}

function parseStoredFieldValue(
	state: ScanState,
	location: string,
	field: DatetimeFieldDescriptor,
	value: unknown,
): unknown {
	if (field.type !== "repeater" || typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch (error) {
		recordError(state, location, value, error);
		return value;
	}
}

async function scanContentRows(
	db: Kysely<Database>,
	schema: CollectionDatetimeSchema,
	state: ScanState,
): Promise<void> {
	validateIdentifier(schema.slug, "collection slug");
	const table = `ec_${schema.slug}`;
	const postgres = db.getExecutor().adapter instanceof PostgresAdapter;
	const fieldColumns = schema.fields.map((field) => field.slug);
	for (const column of fieldColumns) validateIdentifier(column, "content datetime field");
	const columns = [...SYSTEM_DATETIME_COLUMNS, ...fieldColumns];
	let cursor = "";
	for (;;) {
		const selected = [sql.ref("id"), ...columns.map((column) => sql.ref(column))];
		const result = await sql<Record<string, unknown>>`
			SELECT ${sql.join(selected, sql`, `)}
			FROM ${sql.ref(table)}
			WHERE id > ${cursor}
			ORDER BY id
			LIMIT ${DATETIME_MIGRATION_BATCH_SIZE}
		`.execute(db);
		if (result.rows.length === 0) break;
		for (const row of result.rows) {
			const id = String(row.id);
			const changes = new Map<string, DatetimeColumnChange>();
			for (const column of SYSTEM_DATETIME_COLUMNS) {
				const current = row[column];
				if (current === null || current === undefined || current === "") continue;
				try {
					const normalized = normalizeDatetime(current, state.timezone);
					recordNormalization(state, `${table}/${id}.${column}`, current, normalized);
					if (normalized.value !== current) {
						changes.set(column, { before: current, after: normalized.value, json: false });
					}
				} catch (error) {
					recordError(state, `${table}/${id}.${column}`, current, error);
				}
			}

			const data: Record<string, unknown> = {};
			for (const field of schema.fields) {
				data[field.slug] = parseStoredFieldValue(
					state,
					`${table}/${id}.${field.slug}`,
					field,
					row[field.slug],
				);
			}
			for (const field of schema.fields) {
				const before = data[field.slug];
				try {
					const normalized = normalizeContentDatetimes(
						{ [field.slug]: before },
						[field],
						state.timezone,
					);
					state.noncanonicalCount += normalized.changedCount;
					state.naiveCount += normalized.naiveCount;
					if (normalized.changedCount === 0) continue;
					const after = normalized.value[field.slug];
					addSample(state, {
						location: `${table}/${id}.${field.slug}`,
						value: before,
						kind: normalized.naiveCount > 0 ? "naive" : "offset",
					});
					changes.set(field.slug, {
						before: row[field.slug],
						after: field.type === "repeater" ? JSON.stringify(after) : after,
						json: field.type === "repeater",
					});
				} catch (error) {
					recordError(state, `${table}/${id}.${field.slug}`, before, error);
				}
			}

			if (state.write && changes.size > 0) {
				const changeEntries = [...changes];
				for (
					let offset = 0;
					offset < changeEntries.length;
					offset += DATETIME_UPDATE_COLUMN_BATCH_SIZE
				) {
					const batch = changeEntries.slice(offset, offset + DATETIME_UPDATE_COLUMN_BATCH_SIZE);
					const assignments = batch.map(([column, change]) => {
						validateIdentifier(column, "content datetime column");
						return change.json && postgres
							? sql`${sql.ref(column)} = CAST(${change.after} AS JSON)`
							: sql`${sql.ref(column)} = ${change.after}`;
					});
					const predicates = batch.map(([column, change]) =>
						change.json && postgres
							? sql`CAST(${sql.ref(column)} AS JSONB) = CAST(${serializedJson(change.before)} AS JSONB)`
							: sql`${sql.ref(column)} = ${change.before}`,
					);
					await sql`
						UPDATE ${sql.ref(table)}
						SET ${sql.join(assignments, sql`, `)}
						WHERE id = ${id}
						AND ${sql.join(predicates, sql` AND `)}
					`.execute(db);
				}
			}
		}
		cursor = String(result.rows.at(-1)!.id);
		if (result.rows.length < DATETIME_MIGRATION_BATCH_SIZE) break;
	}
}

async function scanRevisions(
	db: Kysely<Database>,
	schemas: Map<string, CollectionDatetimeSchema>,
	state: ScanState,
): Promise<void> {
	let cursor = "";
	for (;;) {
		const rows = await db
			.selectFrom("revisions")
			.select(["id", "collection", "entry_id", "data"])
			.where("id", ">", cursor)
			.orderBy("id")
			.limit(DATETIME_MIGRATION_BATCH_SIZE)
			.execute();
		if (rows.length === 0) break;
		for (const row of rows) {
			const schema = schemas.get(row.collection);
			if (!schema) continue;
			let data: unknown;
			try {
				data = JSON.parse(row.data);
			} catch (error) {
				recordError(state, `revisions/${row.id}.data`, row.data, error);
				continue;
			}
			if (!isRecord(data)) {
				recordError(state, `revisions/${row.id}.data`, data, new Error("Expected a JSON object"));
				continue;
			}
			let normalizedData = data;
			let changed = false;
			for (const field of schema.fields) {
				const before = normalizedData[field.slug];
				try {
					const normalized = normalizeContentDatetimes(
						{ [field.slug]: before },
						[field],
						state.timezone,
					);
					state.noncanonicalCount += normalized.changedCount;
					state.naiveCount += normalized.naiveCount;
					if (normalized.changedCount === 0) continue;
					if (!changed) normalizedData = { ...normalizedData };
					changed = true;
					normalizedData[field.slug] = normalized.value[field.slug];
					addSample(state, {
						location: `revisions/${row.id}.data.${field.slug} (${row.collection}/${row.entry_id})`,
						value: before,
						kind: normalized.naiveCount > 0 ? "naive" : "offset",
					});
				} catch (error) {
					recordError(
						state,
						`revisions/${row.id}.data.${field.slug} (${row.collection}/${row.entry_id})`,
						before,
						error,
					);
				}
			}
			if (state.write && changed) {
				await db
					.updateTable("revisions")
					.set({ data: JSON.stringify(normalizedData) })
					.where("id", "=", row.id)
					.where("data", "=", row.data)
					.execute();
			}
		}
		cursor = rows.at(-1)!.id;
		if (rows.length < DATETIME_MIGRATION_BATCH_SIZE) break;
	}
}

async function scan(db: Kysely<Database>, write: boolean): Promise<DatetimeStorageReport> {
	const [timezone, schemas] = await Promise.all([loadSiteTimezone(db), loadCollectionSchemas(db)]);
	const state: ScanState = {
		timezone,
		noncanonicalCount: 0,
		naiveCount: 0,
		manualReviewCount: 0,
		inspectionErrorCount: 0,
		samples: [],
		write,
	};
	for (const schema of schemas.values()) await scanContentRows(db, schema, state);
	await scanRevisions(db, schemas, state);
	const { write: _write, ...report } = state;
	return report;
}

export function formatDatetimeStorageReport(report: DatetimeStorageReport): string {
	const summary = `${report.noncanonicalCount} noncanonical values (${report.naiveCount} naive) using ${report.timezone}`;
	const samples = report.samples.map(
		(sample) => `${sample.location}: ${sample.message ?? JSON.stringify(sample.value)}`,
	);
	const totalFindings =
		report.noncanonicalCount + report.manualReviewCount + report.inspectionErrorCount;
	const omitted = totalFindings > samples.length ? totalFindings - samples.length : 0;
	return [
		summary,
		...(report.manualReviewCount > 0 || report.inspectionErrorCount > 0
			? [
					`${report.manualReviewCount} require manual review; ${report.inspectionErrorCount} could not be inspected`,
				]
			: []),
		...samples,
		...(omitted > 0 ? [`${omitted} additional findings omitted`] : []),
	].join("\n");
}

export function scanDatetimeStorage(db: Kysely<Database>): Promise<DatetimeStorageReport> {
	return scan(db, false);
}

export async function normalizeDatetimeStorage(
	db: Kysely<Database>,
): Promise<DatetimeStorageReport> {
	const preflight = await scan(db, false);
	console.error(`[datetime migration] ${formatDatetimeStorageReport(preflight)}`);
	if (preflight.manualReviewCount > 0 || preflight.inspectionErrorCount > 0) {
		throw new Error(
			`Datetime migration requires manual review:\n${formatDatetimeStorageReport(preflight)}`,
		);
	}
	if (preflight.noncanonicalCount === 0) return preflight;
	await scan(db, true);
	const verified = await scan(db, false);
	if (
		verified.noncanonicalCount > 0 ||
		verified.manualReviewCount > 0 ||
		verified.inspectionErrorCount > 0
	) {
		throw new Error(
			`Datetime migration did not reach a canonical state:\n${formatDatetimeStorageReport(verified)}`,
		);
	}
	return preflight;
}
