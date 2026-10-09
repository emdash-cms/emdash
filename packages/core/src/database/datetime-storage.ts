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
// D1 rejects a bound string longer than 2,000,000 bytes.
const MAX_JSON_BIND_BYTES = 1_900_000;
const SITE_TIMEZONE_OPTION = "site:timezone";
const RESUME_OPTION = "emdash:datetime_normalization_resume";
const REVISIONS_TABLE = "revisions";

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

interface ContentRowUpdate {
	id: string;
	changes: Map<string, DatetimeColumnChange>;
}

interface RevisionUpdate {
	id: string;
	before: string;
	after: string;
}

interface ScanContext {
	timezone: string;
	schemas: Map<string, CollectionDatetimeSchema>;
	resumeOption: string | undefined;
}

/**
 * Where the write pass continues after an interrupted run: every row of
 * `table` up to id `after`, and of the tables before it, is written. Stored
 * only once the preflight has passed for `timezone`.
 */
interface ResumePoint {
	timezone: string;
	table: string;
	after: string;
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

async function loadScanOptions(
	db: Kysely<Database>,
): Promise<{ timezone: string; resumeOption: string | undefined }> {
	const rows = await db
		.selectFrom("options")
		.select(["name", "value"])
		.where("name", "in", [SITE_TIMEZONE_OPTION, RESUME_OPTION])
		.execute();
	const timezoneRow = rows.find((row) => row.name === SITE_TIMEZONE_OPTION);
	const resumeOption = rows.find((row) => row.name === RESUME_OPTION)?.value;
	if (!timezoneRow) return { timezone: "UTC", resumeOption };
	try {
		const value: unknown = JSON.parse(timezoneRow.value);
		return { timezone: typeof value === "string" && value ? value : "UTC", resumeOption };
	} catch {
		return { timezone: "UTC", resumeOption };
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

function groupByPayloadSize<T extends { payload: string }>(
	entries: readonly T[],
): { batches: T[][]; oversized: T[] } {
	const encoder = new TextEncoder();
	const batches: T[][] = [];
	const oversized: T[] = [];
	let batch: T[] = [];
	let batchBytes = 2;
	for (const entry of entries) {
		const entryBytes = encoder.encode(entry.payload).byteLength;
		if (entryBytes + 2 > MAX_JSON_BIND_BYTES) {
			oversized.push(entry);
			continue;
		}
		if (batch.length > 0 && batchBytes + 1 + entryBytes > MAX_JSON_BIND_BYTES) {
			batches.push(batch);
			batch = [];
			batchBytes = 2;
		}
		batchBytes += (batch.length > 0 ? 1 : 0) + entryBytes;
		batch.push(entry);
	}
	if (batch.length > 0) batches.push(batch);
	return { batches, oversized };
}

function joinPayloads(entries: readonly { payload: string }[]): string {
	return `[${entries.map((entry) => entry.payload).join(",")}]`;
}

function targetColumn(column: string) {
	return sql.ref(`target.${column}`);
}

function inputAfter(index: number) {
	return sql.ref(`input.after_${index}`);
}

function inputBefore(index: number) {
	return sql.ref(`input.before_${index}`);
}

async function updateContentBatch(
	db: Kysely<Database>,
	table: string,
	columns: readonly string[],
	updates: readonly ContentRowUpdate[],
	payload: string,
	postgres: boolean,
): Promise<void> {
	const changed: Array<{ column: string; index: number; json: boolean }> = [];
	for (const [index, column] of columns.entries()) {
		const change = updates.find((update) => update.changes.has(column))?.changes.get(column);
		if (change) changed.push({ column, index, json: change.json });
	}
	const inputColumns = changed.map(({ index }) =>
		postgres
			? sql`entry.value -> 1 ->> ${sql.lit(index)} AS ${sql.ref(`after_${index}`)},
				entry.value -> 2 ->> ${sql.lit(index)} AS ${sql.ref(`before_${index}`)}`
			: sql`json_extract(entry.value, ${sql.lit(`$[1][${index}]`)}) AS ${sql.ref(`after_${index}`)},
				json_extract(entry.value, ${sql.lit(`$[2][${index}]`)}) AS ${sql.ref(`before_${index}`)}`,
	);
	const input = postgres
		? sql`SELECT entry.value ->> 0 AS target_id, ${sql.join(inputColumns)}
			FROM jsonb_array_elements(CAST(${payload} AS jsonb)) AS entry(value)`
		: sql`SELECT json_extract(entry.value, '$[0]') AS target_id, ${sql.join(inputColumns)}
			FROM json_each(${payload}) AS entry`;
	const assignments = changed.map(({ column, index, json }) =>
		json && postgres
			? sql`${sql.ref(column)} = COALESCE(CAST(${inputAfter(index)} AS JSON), ${targetColumn(column)})`
			: sql`${sql.ref(column)} = COALESCE(${inputAfter(index)}, ${targetColumn(column)})`,
	);
	const guards = changed.map(({ column, index, json }) =>
		json && postgres
			? sql`(${inputBefore(index)} IS NULL OR CAST(${targetColumn(column)} AS JSONB) = CAST(${inputBefore(index)} AS JSONB))`
			: sql`(${inputBefore(index)} IS NULL OR ${targetColumn(column)} = ${inputBefore(index)})`,
	);
	await sql`
		WITH input AS (${input})
		UPDATE ${sql.ref(table)} AS target
		SET ${sql.join(assignments, sql`, `)}
		FROM input
		WHERE target.id = input.target_id
		AND ${sql.join(guards, sql` AND `)}
	`.execute(db);
}

async function updateContentRow(
	db: Kysely<Database>,
	table: string,
	update: ContentRowUpdate,
	postgres: boolean,
): Promise<void> {
	const changeEntries = [...update.changes];
	for (let offset = 0; offset < changeEntries.length; offset += DATETIME_UPDATE_COLUMN_BATCH_SIZE) {
		const batch = changeEntries.slice(offset, offset + DATETIME_UPDATE_COLUMN_BATCH_SIZE);
		const assignments = batch.map(([column, change]) =>
			change.json && postgres
				? sql`${sql.ref(column)} = CAST(${change.after} AS JSON)`
				: sql`${sql.ref(column)} = ${change.after}`,
		);
		const predicates = batch.map(([column, change]) =>
			change.json && postgres
				? sql`CAST(${sql.ref(column)} AS JSONB) = CAST(${serializedJson(change.before)} AS JSONB)`
				: sql`${sql.ref(column)} = ${change.before}`,
		);
		await sql`
			UPDATE ${sql.ref(table)}
			SET ${sql.join(assignments, sql`, `)}
			WHERE id = ${update.id}
			AND ${sql.join(predicates, sql` AND `)}
		`.execute(db);
	}
}

async function writeContentUpdates(
	db: Kysely<Database>,
	table: string,
	columns: readonly string[],
	updates: readonly ContentRowUpdate[],
	postgres: boolean,
): Promise<void> {
	const entries = updates.map((update) => ({
		update,
		payload: JSON.stringify([
			update.id,
			columns.map((column) => update.changes.get(column)?.after ?? null),
			columns.map((column) => {
				const change = update.changes.get(column);
				if (!change) return null;
				return change.json ? serializedJson(change.before) : change.before;
			}),
		]),
	}));
	const { batches, oversized } = groupByPayloadSize(entries);
	for (const batch of batches) {
		await updateContentBatch(
			db,
			table,
			columns,
			batch.map((entry) => entry.update),
			joinPayloads(batch),
			postgres,
		);
	}
	for (const { update } of oversized) await updateContentRow(db, table, update, postgres);
}

async function writeRevisionUpdates(
	db: Kysely<Database>,
	updates: readonly RevisionUpdate[],
	postgres: boolean,
): Promise<void> {
	const entries = updates.map((update) => ({
		update,
		payload: JSON.stringify([update.id, update.after, update.before]),
	}));
	const { batches, oversized } = groupByPayloadSize(entries);
	for (const batch of batches) {
		const payload = joinPayloads(batch);
		const input = postgres
			? sql`SELECT entry.value ->> 0 AS target_id, entry.value ->> 1 AS next_data, entry.value ->> 2 AS previous_data
				FROM jsonb_array_elements(CAST(${payload} AS jsonb)) AS entry(value)`
			: sql`SELECT json_extract(entry.value, '$[0]') AS target_id,
					json_extract(entry.value, '$[1]') AS next_data,
					json_extract(entry.value, '$[2]') AS previous_data
				FROM json_each(${payload}) AS entry`;
		await sql`
			WITH input AS (${input})
			UPDATE revisions AS target
			SET data = input.next_data
			FROM input
			WHERE target.id = input.target_id
			AND target.data = input.previous_data
		`.execute(db);
	}
	for (const { update } of oversized) {
		await db
			.updateTable("revisions")
			.set({ data: update.after })
			.where("id", "=", update.id)
			.where("data", "=", update.before)
			.execute();
	}
}

async function saveResumePoint(db: Kysely<Database>, point: ResumePoint): Promise<void> {
	const value = JSON.stringify(point);
	await db
		.insertInto("options")
		.values({ name: RESUME_OPTION, value })
		.onConflict((conflict) => conflict.column("name").doUpdateSet({ value }))
		.execute();
}

async function clearResumePoint(db: Kysely<Database>): Promise<void> {
	await db.deleteFrom("options").where("name", "=", RESUME_OPTION).execute();
}

function scanTables(context: ScanContext): string[] {
	return [...Array.from(context.schemas.keys(), (slug) => `ec_${slug}`), REVISIONS_TABLE];
}

function parseResumePoint(context: ScanContext): ResumePoint | undefined {
	if (context.resumeOption === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(context.resumeOption);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const { timezone, table, after } = parsed;
	if (typeof timezone !== "string" || typeof table !== "string" || typeof after !== "string") {
		return undefined;
	}
	if (timezone !== context.timezone || !scanTables(context).includes(table)) return undefined;
	return { timezone, table, after };
}

async function scanContentRows(
	db: Kysely<Database>,
	schema: CollectionDatetimeSchema,
	state: ScanState,
	startAfter: string,
): Promise<void> {
	validateIdentifier(schema.slug, "collection slug");
	const table = `ec_${schema.slug}`;
	const postgres = db.getExecutor().adapter instanceof PostgresAdapter;
	const fieldColumns = schema.fields.map((field) => field.slug);
	for (const column of fieldColumns) validateIdentifier(column, "content datetime field");
	const columns = [...SYSTEM_DATETIME_COLUMNS, ...fieldColumns];
	let cursor = startAfter;
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
		const updates: ContentRowUpdate[] = [];
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

			if (state.write && changes.size > 0) updates.push({ id, changes });
		}
		cursor = String(result.rows.at(-1)!.id);
		if (updates.length > 0) {
			await writeContentUpdates(db, table, columns, updates, postgres);
			await saveResumePoint(db, { timezone: state.timezone, table, after: cursor });
		}
		if (result.rows.length < DATETIME_MIGRATION_BATCH_SIZE) break;
	}
}

async function scanRevisions(
	db: Kysely<Database>,
	schemas: Map<string, CollectionDatetimeSchema>,
	state: ScanState,
	startAfter: string,
): Promise<void> {
	const postgres = db.getExecutor().adapter instanceof PostgresAdapter;
	let cursor = startAfter;
	for (;;) {
		const rows = await db
			.selectFrom("revisions")
			.select(["id", "collection", "entry_id", "data"])
			.where("id", ">", cursor)
			.orderBy("id")
			.limit(DATETIME_MIGRATION_BATCH_SIZE)
			.execute();
		if (rows.length === 0) break;
		const updates: RevisionUpdate[] = [];
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
				updates.push({ id: row.id, before: row.data, after: JSON.stringify(normalizedData) });
			}
		}
		cursor = rows.at(-1)!.id;
		if (updates.length > 0) {
			await writeRevisionUpdates(db, updates, postgres);
			await saveResumePoint(db, {
				timezone: state.timezone,
				table: REVISIONS_TABLE,
				after: cursor,
			});
		}
		if (rows.length < DATETIME_MIGRATION_BATCH_SIZE) break;
	}
}

async function loadScanContext(db: Kysely<Database>): Promise<ScanContext> {
	const [options, schemas] = await Promise.all([loadScanOptions(db), loadCollectionSchemas(db)]);
	return { ...options, schemas };
}

async function scan(
	db: Kysely<Database>,
	context: ScanContext,
	write: boolean,
	start?: ResumePoint,
): Promise<DatetimeStorageReport> {
	const state: ScanState = {
		timezone: context.timezone,
		noncanonicalCount: 0,
		naiveCount: 0,
		manualReviewCount: 0,
		inspectionErrorCount: 0,
		samples: [],
		write,
	};
	const tables = scanTables(context);
	let pending = start;
	for (const [index, schema] of [...context.schemas.values()].entries()) {
		if (pending && pending.table !== `ec_${schema.slug}`) continue;
		await scanContentRows(db, schema, state, pending?.after ?? "");
		pending = undefined;
		const next = tables[index + 1];
		if (write && next)
			await saveResumePoint(db, { timezone: state.timezone, table: next, after: "" });
	}
	await scanRevisions(db, context.schemas, state, pending?.after ?? "");
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

export async function scanDatetimeStorage(db: Kysely<Database>): Promise<DatetimeStorageReport> {
	return scan(db, await loadScanContext(db), false);
}

export async function normalizeDatetimeStorage(
	db: Kysely<Database>,
): Promise<DatetimeStorageReport> {
	const context = await loadScanContext(db);
	const resumeFrom = parseResumePoint(context);
	let preflight: DatetimeStorageReport | undefined;
	if (resumeFrom) {
		console.info(
			`[datetime migration] resuming in ${resumeFrom.table} after ${JSON.stringify(resumeFrom.after)} using ${resumeFrom.timezone}`,
		);
	} else {
		preflight = await scan(db, context, false);
		if (preflight.manualReviewCount > 0 || preflight.inspectionErrorCount > 0) {
			throw new Error(
				`Datetime migration requires manual review:\n${formatDatetimeStorageReport(preflight)}`,
			);
		}
		if (preflight.noncanonicalCount === 0) {
			if (context.resumeOption !== undefined) await clearResumePoint(db);
			return preflight;
		}
		console.info(`[datetime migration] ${formatDatetimeStorageReport(preflight)}`);
		const [firstTable = REVISIONS_TABLE] = scanTables(context);
		await saveResumePoint(db, { timezone: context.timezone, table: firstTable, after: "" });
	}
	const written = await scan(db, context, true, resumeFrom);
	const verified = await scan(db, context, false);
	await clearResumePoint(db);
	if (
		verified.noncanonicalCount > 0 ||
		verified.manualReviewCount > 0 ||
		verified.inspectionErrorCount > 0
	) {
		throw new Error(
			`Datetime migration did not reach a canonical state:\n${formatDatetimeStorageReport(verified)}`,
		);
	}
	return preflight ?? written;
}
