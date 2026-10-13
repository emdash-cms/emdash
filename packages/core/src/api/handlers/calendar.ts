/**
 * Calendar handler
 *
 * Lists published entries at their publish time and scheduled entries at
 * their scheduled time, across every visible collection, in time order.
 */

import { sql, type Kysely, type RawBuilder } from "kysely";

import {
	InvalidCursorError,
	decodeCursor,
	encodeCursor,
} from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import type { ApiResult } from "../types.js";

export type CalendarEntryKind = "published" | "scheduled";

export interface CalendarEntry {
	collection: string;
	id: string;
	locale: string;
	title: string;
	status: string;
	kind: CalendarEntryKind;
	at: string;
}

export interface CalendarEntriesResponse {
	items: CalendarEntry[];
	nextCursor?: string;
}

export interface CalendarEntriesParams {
	from: string;
	to: string;
	cursor?: string;
	limit: number;
}

const KINDS: readonly CalendarEntryKind[] = ["published", "scheduled"];
const KIND_COLUMN = { published: "published_at", scheduled: "scheduled_at" } as const;
const TITLE_FIELD_TYPES = ["string", "text", "slug"];
const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

interface Stream {
	collection: string;
	kind: CalendarEntryKind;
	title: RawBuilder<string>;
}

interface CalendarCursor {
	at: string;
	collection: string;
	kind: CalendarEntryKind;
	id: string;
}

interface StreamRow {
	id: string;
	locale: string;
	status: string;
	title: string;
	event_at: string;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Streams run in collection slug order, published before scheduled. */
function compareStreams(
	a: { collection: string; kind: CalendarEntryKind },
	b: { collection: string; kind: CalendarEntryKind },
): number {
	return compareText(a.collection, b.collection) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
}

function isKind(value: string | undefined): value is CalendarEntryKind {
	return value === "published" || value === "scheduled";
}

/** Stored timestamps are canonical `toISOString()` values. */
function isCanonicalTime(value: string): boolean {
	const time = Date.parse(value);
	return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function encodeCalendarCursor(entry: CalendarEntry): string {
	return encodeCursor(`${entry.at}|${entry.collection}|${entry.kind}`, entry.id);
}

function decodeCalendarCursor(cursor: string): CalendarCursor {
	const { orderValue, id } = decodeCursor(cursor);
	const [at = "", collection = "", kind, ...rest] = orderValue.split("|");
	if (
		rest.length > 0 ||
		!isCanonicalTime(at) ||
		!SLUG_PATTERN.test(collection) ||
		!isKind(kind) ||
		!id
	) {
		throw new InvalidCursorError(cursor);
	}
	return { at, collection, kind, id };
}

/**
 * Title columns follow the admin's rule: the collection's title field, then
 * `title`, then `name`, skipping empty values, then the slug and the id. A
 * `title_field` that names no text field is ignored.
 */
async function loadStreams(db: Kysely<Database>): Promise<Stream[]> {
	const rows = await db
		.selectFrom("_emdash_collections as c")
		.leftJoin("_emdash_fields as f", (join) =>
			join
				.onRef("f.collection_id", "=", "c.id")
				.on("f.type", "in", TITLE_FIELD_TYPES)
				.on((eb) =>
					eb.or([
						eb("f.slug", "in", ["title", "name"]),
						eb("f.slug", "=", eb.ref("c.title_field")),
					]),
				),
		)
		.select(["c.slug as slug", "c.title_field as title_field", "f.slug as field"])
		.where("c.hidden", "=", 0)
		.execute();

	const collections = new Map<string, { titleField: string | null; fields: Set<string> }>();
	for (const row of rows) {
		const collection = collections.get(row.slug) ?? {
			titleField: row.title_field,
			fields: new Set<string>(),
		};
		if (row.field) collection.fields.add(row.field);
		collections.set(row.slug, collection);
	}

	return [...collections.entries()]
		.toSorted(([a], [b]) => compareText(a, b))
		.flatMap(([slug, { titleField, fields }]) => {
			validateIdentifier(slug, "collection slug");
			const columns = [...new Set([titleField, "title", "name"])].filter(
				(column): column is string => !!column && fields.has(column),
			);
			const title = sql<string>`COALESCE(${sql.join(
				[...columns, "slug"].map((column) => {
					validateIdentifier(column, "title column");
					return sql`NULLIF(${sql.ref(column)}, '')`;
				}),
			)}, id)`;
			return KINDS.map((kind) => ({ collection: slug, kind, title }));
		});
}

function keysetCondition(stream: Stream, cursor: CalendarCursor | undefined) {
	if (!cursor) return sql``;
	const column = sql.ref(KIND_COLUMN[stream.kind]);
	const order = compareStreams(stream, cursor);
	if (order < 0) return sql`AND ${column} > ${cursor.at}`;
	if (order === 0) return sql`AND (${column} > ${cursor.at} OR id > ${cursor.id})`;
	return sql``;
}

async function queryStream(
	db: Kysely<Database>,
	stream: Stream,
	params: CalendarEntriesParams,
	cursor: CalendarCursor | undefined,
): Promise<StreamRow[]> {
	const column = sql.ref(KIND_COLUMN[stream.kind]);
	const lower = cursor && cursor.at > params.from ? cursor.at : params.from;
	const result = await sql<StreamRow>`
		SELECT id, locale, status, ${stream.title} AS title, ${column} AS event_at
		FROM ${sql.ref(`ec_${stream.collection}`)}
		WHERE deleted_at IS NULL
			AND ${column} IS NOT NULL
			AND ${column} >= ${lower}
			AND ${column} < ${params.to}
			${stream.kind === "published" ? sql`AND status = 'published'` : sql``}
			${keysetCondition(stream, cursor)}
		ORDER BY ${column} ASC, id ASC
		LIMIT ${params.limit + 1}
	`.execute(db);
	return result.rows;
}

/**
 * Each stream (one collection and kind) is read in its own query, and the
 * rows are merged by time. Ties keep the stream order and then each stream's
 * SQL order, which matches the next page's keyset conditions.
 */
export async function handleCalendarEntries(
	db: Kysely<Database>,
	params: CalendarEntriesParams,
): Promise<ApiResult<CalendarEntriesResponse>> {
	try {
		const cursor = params.cursor ? decodeCalendarCursor(params.cursor) : undefined;
		const streams = await loadStreams(db);
		const results = await Promise.all(
			streams.map(async (stream) => {
				const rows = await queryStream(db, stream, params, cursor);
				return rows.map((row, position) => ({ row, stream, position }));
			}),
		);

		const merged = results
			.flat()
			.toSorted(
				(a, b) =>
					compareText(a.row.event_at, b.row.event_at) ||
					compareStreams(a.stream, b.stream) ||
					a.position - b.position,
			);

		const items = merged.slice(0, params.limit).map(
			({ row, stream }): CalendarEntry => ({
				collection: stream.collection,
				id: row.id,
				locale: row.locale,
				title: row.title,
				status: row.status,
				kind: stream.kind,
				at: row.event_at,
			}),
		);
		const last = items.at(-1);
		const nextCursor =
			merged.length > params.limit && last ? encodeCalendarCursor(last) : undefined;

		return { success: true, data: nextCursor ? { items, nextCursor } : { items } };
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return { success: false, error: { code: "INVALID_CURSOR", message: error.message } };
		}
		console.error("Calendar error:", error);
		return {
			success: false,
			error: { code: "CALENDAR_ERROR", message: "Failed to load calendar" },
		};
	}
}
