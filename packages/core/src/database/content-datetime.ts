import type { Kysely } from "kysely";

import {
	DatetimeNormalizationError,
	normalizeContentDatetimes,
	normalizeDatetime,
	type DatetimeFieldDescriptor,
} from "../datetime-normalization.js";
import type { RepeaterSubField } from "../schema/types.js";
import { EmDashValidationError } from "./repositories/types.js";
import type { Database } from "./types.js";

interface DatetimeContext {
	timezone: string;
	fields: DatetimeFieldDescriptor[];
}

function repeaterDatetimeFields(validation: string | null): string[] {
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
				field.type === "datetime" &&
				"slug" in field &&
				typeof field.slug === "string",
		)
		.map((field) => field.slug);
}

export class ContentDatetimeNormalizer {
	constructor(private readonly db: Kysely<Database>) {}

	private context(collection: string): Promise<DatetimeContext> {
		return this.loadContext(collection);
	}

	private async loadContext(collection: string): Promise<DatetimeContext> {
		const [rows, timezoneRow] = await Promise.all([
			this.db
				.selectFrom("_emdash_fields as field")
				.innerJoin("_emdash_collections as collection", "collection.id", "field.collection_id")
				.select(["field.slug", "field.type", "field.validation"])
				.where("collection.slug", "=", collection)
				.where("field.type", "in", ["datetime", "repeater"])
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
		return {
			timezone,
			fields: rows.map((row) =>
				row.type === "datetime"
					? { slug: row.slug, type: "datetime" }
					: {
							slug: row.slug,
							type: "repeater",
							datetimeSubFields: repeaterDatetimeFields(row.validation),
						},
			),
		};
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
		const context = await this.context(collection);
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
