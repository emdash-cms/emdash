/**
 * Parse a Contentful CDA response JSON into typed, grouped entries.
 *
 * Supports the CDA collection response format:
 *   { sys, total, items: [...], includes: { Entry: [...], Asset: [...] } }
 *
 * Entries in `items` are grouped by content type ID. Entries and assets
 * are merged into a single ContentfulIncludes map for cross-reference
 * resolution (since items reference each other via embedded entries).
 */

import { buildIncludes, type ContentfulIncludes } from "@emdash-cms/contentful-to-portable-text";

/** A raw Contentful entry from the CDA response */
export interface RawContentfulEntry {
	sys: {
		id: string;
		type: string;
		createdAt: string;
		updatedAt: string;
		contentType: {
			sys: { id: string };
		};
		locale?: string;
	};
	fields: Record<string, unknown>;
}

/** Parsed and grouped result from a Contentful export */
export interface ParsedContentfulExport {
	/** All entries grouped by content type ID */
	byType: Map<string, RawContentfulEntry[]>;
	/** Merged includes map (items + includes.Entry + includes.Asset) */
	includes: ContentfulIncludes;
	/** Summary counts by content type */
	counts: Record<string, number>;
}

/**
 * Parse a Contentful CDA response JSON object.
 */
export function parseContentfulExport(raw: Record<string, unknown>): ParsedContentfulExport {
	const items = (raw.items ?? []) as Array<Record<string, unknown>>;
	const rawIncludes = (raw.includes ?? {}) as {
		Entry?: Array<Record<string, unknown>>;
		Asset?: Array<Record<string, unknown>>;
	};

	// Build includes from the dedicated includes section
	const includes = buildIncludes(rawIncludes);

	// Also inject all top-level items into the includes entries map,
	// since embedded entries reference other top-level items
	for (const item of items) {
		const sys = item.sys as RawContentfulEntry["sys"] | undefined;
		if (sys?.contentType?.sys?.id) {
			includes.entries.set(sys.id, {
				id: sys.id,
				contentType: sys.contentType.sys.id,
				fields: (item.fields as Record<string, unknown>) ?? {},
			});
		}
	}

	// Group items by content type
	const byType = new Map<string, RawContentfulEntry[]>();
	const counts: Record<string, number> = {};

	for (const item of items) {
		const sys = item.sys as RawContentfulEntry["sys"] | undefined;
		const contentType = sys?.contentType?.sys?.id;
		if (!contentType || !sys) continue;

		const entry: RawContentfulEntry = {
			sys: sys,
			fields: (item.fields as Record<string, unknown>) ?? {},
		};

		if (!byType.has(contentType)) {
			byType.set(contentType, []);
		}
		byType.get(contentType)!.push(entry);
		counts[contentType] = (counts[contentType] ?? 0) + 1;
	}

	return { byType, includes, counts };
}
