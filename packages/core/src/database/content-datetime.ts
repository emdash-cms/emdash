import type { Kysely } from "kysely";

import {
	DatetimeNormalizationError,
	normalizeContentDatetimes,
	normalizeDatetime,
	type DatetimeFieldDescriptor,
} from "../datetime-normalization.js";
import { requestCached } from "../request-cache.js";
import { isStoragelessFieldRow, type FieldType, type RepeaterSubField } from "../schema/types.js";
import { isSafeMediaUrl, isSafeUrlFieldWriteValue } from "../utils/url.js";
import { EmDashValidationError } from "./repositories/types.js";
import type { Database } from "./types.js";

interface UrlFieldDescriptor {
	slug: string;
	urlSubFields?: readonly string[];
}

interface MediaFieldDescriptor {
	slug: string;
	mediaSubFields?: readonly string[];
}

interface DatetimeContext {
	timezone: string;
	fields: DatetimeFieldDescriptor[];
	urlFields: UrlFieldDescriptor[];
	mediaFields: MediaFieldDescriptor[];
	writableFieldSlugs: ReadonlySet<string>;
}

function repeaterSubFieldsOfType(validation: string | null, type: FieldType): string[] {
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
	return subFields
		.filter(
			(field): field is RepeaterSubField =>
				typeof field === "object" &&
				field !== null &&
				"type" in field &&
				field.type === type &&
				"slug" in field &&
				typeof field.slug === "string",
		)
		.map((field) => field.slug);
}

/**
 * Datetime contexts by collection slug, shared so that a bulk write reads each
 * collection's context once. A cached context doesn't see later writes to the
 * `site:timezone` setting or to field definitions, so share one only across
 * work that makes neither.
 */
export type DatetimeContextCache = Map<string, Promise<DatetimeContext>>;

export class ContentDatetimeNormalizer {
	constructor(
		private readonly db: Kysely<Database>,
		private readonly contexts?: DatetimeContextCache,
	) {}

	private context(collection: string): Promise<DatetimeContext> {
		if (this.contexts) {
			let context = this.contexts.get(collection);
			if (!context) {
				context = this.loadContext(collection);
				this.contexts.set(collection, context);
			}
			return context;
		}
		// Fall back to the per-request cache so repeated writes in the same
		// invocation (e.g. bulk imports) do not re-query field/timezone metadata
		// for every item.
		return requestCached(`datetimeContext:${collection}`, () => this.loadContext(collection));
	}

	private async loadContext(collection: string): Promise<DatetimeContext> {
		const [rows, timezoneRow] = await Promise.all([
			this.db
				.selectFrom("_emdash_fields as field")
				.innerJoin("_emdash_collections as collection", "collection.id", "field.collection_id")
				.select(["field.slug", "field.type", "field.validation"])
				.where("collection.slug", "=", collection)
				.execute(),
			this.db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "site:timezone")
				.executeTakeFirst(),
		]);
		let timezone = "UTC";
		if (timezoneRow) {
			try {
				const configured: unknown = JSON.parse(timezoneRow.value);
				if (typeof configured === "string" && configured) timezone = configured;
			} catch {
				// The datetime normalizer reports an invalid timezone when it encounters a value.
			}
		}
		const fields: DatetimeFieldDescriptor[] = [];
		const urlFields: UrlFieldDescriptor[] = [];
		const mediaFields: MediaFieldDescriptor[] = [];
		for (const row of rows) {
			if (row.type === "datetime") {
				fields.push({ slug: row.slug, type: "datetime" });
			} else if (row.type === "url") {
				urlFields.push({ slug: row.slug });
			} else if (row.type === "image" || row.type === "file") {
				mediaFields.push({ slug: row.slug });
			} else if (row.type === "repeater") {
				fields.push({
					slug: row.slug,
					type: "repeater",
					datetimeSubFields: repeaterSubFieldsOfType(row.validation, "datetime"),
				});
				const urlSubFields = repeaterSubFieldsOfType(row.validation, "url");
				if (urlSubFields.length > 0) urlFields.push({ slug: row.slug, urlSubFields });
				const mediaSubFields = repeaterSubFieldsOfType(row.validation, "image");
				if (mediaSubFields.length > 0) mediaFields.push({ slug: row.slug, mediaSubFields });
			}
		}
		const writableFieldSlugs = new Set(
			rows.filter((field) => !isStoragelessFieldRow(field)).map((field) => field.slug),
		);
		return { timezone, fields, urlFields, mediaFields, writableFieldSlugs };
	}

	async writableFieldSlugs(collection: string): Promise<ReadonlySet<string>> {
		return (await this.context(collection)).writableFieldSlugs;
	}

	/**
	 * Normalizes datetimes in incoming field values and rejects `url` values
	 * with unsafe schemes, control characters, or off-site path forms, and
	 * `image` and `file` values whose URLs have unsafe schemes or control
	 * characters. Values already stored are not checked, so restoring or
	 * syncing existing data goes through {@link normalizeData} instead.
	 */
	async normalizeInput(
		collection: string,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const context = await this.context(collection);
		assertSafeUrlFields(data, context.urlFields);
		assertSafeMediaFields(data, context.mediaFields);
		return this.normalizeWithContext(context, [data])[0] ?? data;
	}

	async normalizeData(
		collection: string,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const [normalized] = await this.normalizeDataMany(collection, [data]);
		return normalized ?? data;
	}

	async normalizeDataMany(
		collection: string,
		items: readonly Record<string, unknown>[],
	): Promise<Record<string, unknown>[]> {
		return this.normalizeWithContext(await this.context(collection), items);
	}

	private normalizeWithContext(
		context: DatetimeContext,
		items: readonly Record<string, unknown>[],
	): Record<string, unknown>[] {
		try {
			return items.map(
				(data) => normalizeContentDatetimes(data, context.fields, context.timezone).value,
			);
		} catch (error) {
			if (error instanceof DatetimeNormalizationError) {
				throw new EmDashValidationError(error.message);
			}
			throw error;
		}
	}

	async normalizeValue(collection: string, value: string | Date): Promise<string> {
		const context = await this.context(collection);
		try {
			return normalizeDatetime(value, context.timezone).value;
		} catch (error) {
			if (error instanceof DatetimeNormalizationError) {
				throw new EmDashValidationError(error.message);
			}
			throw error;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reads parse a stored string that looks like JSON, so a repeater written as a JSON string
// comes back as rows and must be checked as rows.
function repeaterRows(value: unknown): unknown[] | undefined {
	let rows = value;
	if (typeof rows === "string" && rows.startsWith("[")) {
		try {
			rows = JSON.parse(rows);
		} catch {
			return undefined;
		}
	}
	return Array.isArray(rows) ? rows : undefined;
}

function assertSafeUrl(path: string, value: unknown): void {
	if (value !== undefined && value !== null && !isSafeUrlFieldWriteValue(value)) {
		throw new EmDashValidationError(
			`Field "${path}" must use http, https, mailto, or tel, or be a safe relative path or fragment`,
			{ path },
		);
	}
}

function assertSafeUrlFields(
	data: Record<string, unknown>,
	urlFields: readonly UrlFieldDescriptor[],
): void {
	for (const field of urlFields) {
		const value = data[field.slug];
		if (!field.urlSubFields) {
			assertSafeUrl(field.slug, value);
			continue;
		}
		const rows = repeaterRows(value);
		if (!rows) continue;
		for (const [index, row] of rows.entries()) {
			if (!isRecord(row)) continue;
			for (const subField of field.urlSubFields) {
				assertSafeUrl(`${field.slug}.${index}.${subField}`, row[subField]);
			}
		}
	}
}

const MEDIA_URL_KEYS = ["src", "url", "previewUrl"] as const;

// Reads parse a stored string that looks like JSON, so a media value written as a JSON string
// comes back as an object and must be checked as one, and one that starts with `[` comes back
// as an array rather than a URL. Any other string is the URL itself.
function assertSafeMedia(path: string, value: unknown, allowDarkVariant = true): void {
	let media = value;
	if (typeof media === "string" && media.trimStart().startsWith("[")) {
		throw unsafeMediaUrlError(path);
	}
	if (typeof media === "string" && media.startsWith("{")) {
		try {
			media = JSON.parse(media);
		} catch {
			// Stays a string on read too.
		}
	}
	if (typeof media === "string") {
		assertSafeMediaUrl(path, media);
		return;
	}
	if (!isRecord(media)) return;
	for (const key of MEDIA_URL_KEYS) assertSafeMediaUrl(`${path}.${key}`, media[key]);
	if (allowDarkVariant) assertSafeMedia(`${path}.darkVariant`, media.darkVariant, false);
}

function assertSafeMediaUrl(path: string, value: unknown): void {
	if (value === undefined || value === null) return;
	if (typeof value !== "string" || !isSafeMediaUrl(value)) throw unsafeMediaUrlError(path);
}

function unsafeMediaUrlError(path: string): EmDashValidationError {
	return new EmDashValidationError(
		`Field "${path}" must be text that uses http or https, or a relative path`,
		{ path },
	);
}

function assertSafeMediaFields(
	data: Record<string, unknown>,
	mediaFields: readonly MediaFieldDescriptor[],
): void {
	for (const field of mediaFields) {
		const value = data[field.slug];
		if (!field.mediaSubFields) {
			assertSafeMedia(field.slug, value);
			continue;
		}
		const rows = repeaterRows(value);
		if (!rows) continue;
		for (const [index, row] of rows.entries()) {
			if (!isRecord(row)) continue;
			for (const subField of field.mediaSubFields) {
				assertSafeMedia(`${field.slug}.${index}.${subField}`, row[subField]);
			}
		}
	}
}
