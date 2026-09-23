import type { Kysely } from "kysely";
import type { z } from "zod";

import { taxonomyTag } from "../../cache/chrome-tags.js";
import { ContentRepository } from "../../database/repositories/content.js";
import { TaxonomyRepository } from "../../database/repositories/taxonomy.js";
import type { ContentItem } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { getI18nConfig } from "../../i18n/config.js";
import { localizePath, resolveLocalizedContentRoutePath } from "../../i18n/resolve.js";
import { SchemaRegistry } from "../../schema/registry.js";
import { compileUrlPattern } from "../../schema/url-pattern.js";
import { invalidateTermCache } from "../../taxonomies/index.js";
import { chunks } from "../../utils/chunks.js";
import type { bulkTagBody } from "../schemas/taxonomies.js";
import type { ApiResult } from "../types.js";

type BulkTagInput = z.infer<typeof bulkTagBody>;
type BulkTagSource = BulkTagInput["items"][number];
type Collection = Awaited<ReturnType<SchemaRegistry["listCollections"]>>[number];
const TRAILING_SLASHES = /\/+$/;

export interface BulkTagResult {
	input: BulkTagSource;
	status: "ready" | "added" | "skipped" | "unmatched" | "failed";
	reason?: "not_found" | "ambiguous" | "save_failed";
	entry?: { collection: string; id: string; title: string; locale: string };
}

function titleFor(item: ContentItem, collection: Collection): string {
	const preferred = collection.titleField && item.data[collection.titleField];
	const title = item.data.title;
	const name = item.data.name;
	return (
		(typeof preferred === "string" && preferred) ||
		(typeof title === "string" && title) ||
		(typeof name === "string" && name) ||
		item.slug ||
		item.id
	);
}

function normalizedPath(path: string): string {
	return path.replace(TRAILING_SLASHES, "") || "/";
}

async function resolveUrl(
	url: string,
	origin: string,
	collections: Collection[],
	content: ContentRepository,
): Promise<{ item: ContentItem; collection: Collection } | "not_found" | "ambiguous"> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "not_found";
	}
	if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol))
		return "not_found";

	const locales = getI18nConfig()?.locales ?? ["en"];
	const matches = new Map<string, { item: ContentItem; collection: Collection }>();
	for (const collection of collections) {
		const pattern = collection.urlPattern ?? `/${collection.slug}/{slug}`;
		for (const locale of locales) {
			const prefix = await localizePath("/", locale);
			if (!prefix) continue;
			const { regex, paramNames } = compileUrlPattern(`${prefix === "/" ? "" : prefix}${pattern}`);
			const segments = regex.exec(parsed.pathname);
			if (!segments) continue;
			const slugIndex = paramNames.indexOf("slug");
			const idIndex = paramNames.indexOf("id");
			if (slugIndex < 0 && idIndex < 0) continue;
			let identifier: string;
			try {
				identifier = decodeURIComponent(segments[1 + (slugIndex >= 0 ? slugIndex : idIndex)] ?? "");
			} catch {
				continue;
			}
			const item =
				slugIndex >= 0
					? await content.findBySlug(collection.slug, identifier, locale)
					: await content.findById(collection.slug, identifier);
			if (!item || item.locale !== locale || !item.liveRevisionId || !item.slug) continue;
			const canonical = await resolveLocalizedContentRoutePath({
				pattern,
				collection: collection.slug,
				slug: item.slug,
				id: item.id,
				date: item.publishedAt,
				locale,
			});
			if (canonical && normalizedPath(canonical) === normalizedPath(parsed.pathname)) {
				matches.set(`${collection.slug}:${item.id}`, { item, collection });
			}
		}
	}
	if (matches.size > 1) return "ambiguous";
	return matches.values().next().value ?? "not_found";
}

export async function handleBulkTag(
	db: Kysely<Database>,
	origin: string,
	input: BulkTagInput,
	invalidate?: (tags: string[]) => Promise<void>,
): Promise<ApiResult<{ results: BulkTagResult[] }>> {
	try {
		const taxonomy = new TaxonomyRepository(db);
		const term = await taxonomy.findById(input.termId);
		if (!term || term.name !== "tag") {
			return { success: false, error: { code: "NOT_FOUND", message: "Tag not found" } };
		}
		const definitions = await db
			.selectFrom("_emdash_taxonomy_defs")
			.select("collections")
			.where("name", "=", "tag")
			.execute();
		const allowed = new Set(
			definitions.flatMap((def) => {
				const parsed: unknown = def.collections ? JSON.parse(def.collections) : [];
				return Array.isArray(parsed)
					? parsed.filter((value): value is string => typeof value === "string")
					: [];
			}),
		);
		const collections = (await new SchemaRegistry(db).listCollections()).filter((collection) =>
			allowed.has(collection.slug),
		);
		const byCollection = new Map(collections.map((collection) => [collection.slug, collection]));
		const content = new ContentRepository(db);
		const seen = new Set<string>();
		const purge = new Set<string>([taxonomyTag("tag")]);
		const results: BulkTagResult[] = [];
		let changed = false;
		for (const source of input.items) {
			let resolved: Awaited<ReturnType<typeof resolveUrl>>;
			if ("url" in source) {
				resolved = await resolveUrl(source.url, origin, collections, content);
			} else {
				const collection = byCollection.get(source.collection);
				const item = collection ? await content.findById(source.collection, source.id) : null;
				resolved = item && collection ? { item, collection } : "not_found";
			}
			if (typeof resolved === "string") {
				results.push({ input: source, status: "unmatched", reason: resolved });
				continue;
			}
			const { item, collection } = resolved;
			const entry = {
				collection: collection.slug,
				id: item.id,
				title: titleFor(item, collection),
				locale: item.locale ?? "en",
			};
			const group = item.translationGroup ?? item.id;
			const key = `${collection.slug}:${group}`;
			if (seen.has(key)) {
				results.push({ input: source, status: "skipped", entry });
				continue;
			}
			try {
				const assigned = await db
					.selectFrom("content_taxonomies")
					.select("entry_id")
					.where("collection", "=", collection.slug)
					.where("entry_id", "=", group)
					.where("taxonomy_id", "=", term.translationGroup ?? term.id)
					.executeTakeFirst();
				const inserted =
					input.apply && !assigned
						? await taxonomy.attachGroupsToEntry(collection.slug, item.id, [
								term.translationGroup ?? term.id,
							])
						: 0;
				if (inserted) changed = true;
				seen.add(key);
				if (input.apply) {
					purge.add(collection.slug);
					for (const id of await content.findTranslationIds(collection.slug, group)) purge.add(id);
				}
				results.push({
					input: source,
					status:
						assigned || (input.apply && !inserted) ? "skipped" : input.apply ? "added" : "ready",
					entry,
				});
			} catch (error) {
				console.error("[bulk-tag] Failed to tag entry:", error);
				results.push({ input: source, status: "failed", reason: "save_failed", entry });
			}
		}
		if (changed) invalidateTermCache();
		if (input.apply && invalidate && purge.size > 1) {
			for (const batch of chunks([...purge], 100)) await invalidate(batch);
		}
		return { success: true, data: { results } };
	} catch (error) {
		console.error("[bulk-tag] Failed:", error);
		return {
			success: false,
			error: { code: "BULK_TAG_ERROR", message: "Failed to bulk tag posts" },
		};
	}
}
