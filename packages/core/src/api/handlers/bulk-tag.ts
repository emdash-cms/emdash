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
type UrlCandidate = {
	collection: Collection;
	locale: string;
	identifier: string;
	by: "slug" | "id";
};
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

async function urlCandidates(
	url: string,
	origin: string,
	collections: Collection[],
): Promise<{ path: string; candidates: UrlCandidate[] } | null> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) return null;

	const locales = getI18nConfig()?.locales ?? ["en"];
	const candidates: UrlCandidate[] = [];
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
			candidates.push({ collection, locale, identifier, by: slugIndex >= 0 ? "slug" : "id" });
		}
	}
	return { path: parsed.pathname, candidates };
}

export async function handleBulkTag(
	db: Kysely<Database>,
	origin: string,
	input: BulkTagInput,
	invalidate?: (tags: string[]) => Promise<void>,
): Promise<ApiResult<{ results: BulkTagResult[]; cacheRefreshFailed: boolean }>> {
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
		const idNeeds = new Map<string, Set<string>>();
		const slugNeeds = new Map<string, { collection: string; locale: string; slugs: Set<string> }>();
		const parsedUrls = new Map<number, Awaited<ReturnType<typeof urlCandidates>>>();
		for (const [index, source] of input.items.entries()) {
			if ("url" in source) {
				const parsed = await urlCandidates(source.url, origin, collections);
				parsedUrls.set(index, parsed);
				for (const candidate of parsed?.candidates ?? []) {
					if (candidate.by === "id") {
						const ids = idNeeds.get(candidate.collection.slug) ?? new Set<string>();
						ids.add(candidate.identifier);
						idNeeds.set(candidate.collection.slug, ids);
					} else {
						const key = `${candidate.collection.slug}:${candidate.locale}`;
						const group = slugNeeds.get(key) ?? {
							collection: candidate.collection.slug,
							locale: candidate.locale,
							slugs: new Set<string>(),
						};
						group.slugs.add(candidate.identifier);
						slugNeeds.set(key, group);
					}
				}
			} else if (byCollection.has(source.collection)) {
				const ids = idNeeds.get(source.collection) ?? new Set<string>();
				ids.add(source.id);
				idNeeds.set(source.collection, ids);
			}
		}
		const byId = new Map<string, Map<string, ContentItem>>();
		for (const [collection, ids] of idNeeds) {
			byId.set(collection, await content.findManyByIds(collection, [...ids]));
		}
		const bySlug = new Map<string, Map<string, ContentItem>>();
		for (const [key, group] of slugNeeds) {
			bySlug.set(
				key,
				await content.findManyBySlugsInLocale(group.collection, [...group.slugs], group.locale),
			);
		}
		const prepared: Array<{
			source: BulkTagSource;
			resolved: { item: ContentItem; collection: Collection } | "not_found" | "ambiguous";
		}> = [];
		const groups = new Map<string, Set<string>>();
		for (const [index, source] of input.items.entries()) {
			let resolved: (typeof prepared)[number]["resolved"] = "not_found";
			if ("url" in source) {
				const parsed = parsedUrls.get(index);
				const matches = new Map<string, { item: ContentItem; collection: Collection }>();
				for (const candidate of parsed?.candidates ?? []) {
					const item =
						candidate.by === "id"
							? byId.get(candidate.collection.slug)?.get(candidate.identifier)
							: bySlug
									.get(`${candidate.collection.slug}:${candidate.locale}`)
									?.get(candidate.identifier);
					if (!item || item.locale !== candidate.locale || item.status !== "published") continue;
					const canonical = await resolveLocalizedContentRoutePath({
						pattern: candidate.collection.urlPattern ?? `/${candidate.collection.slug}/{slug}`,
						collection: candidate.collection.slug,
						slug: item.slug ?? "",
						id: item.id,
						date: item.publishedAt,
						locale: candidate.locale,
					});
					if (canonical && parsed && normalizedPath(canonical) === normalizedPath(parsed.path)) {
						matches.set(`${candidate.collection.slug}:${item.id}`, {
							item,
							collection: candidate.collection,
						});
					}
				}
				resolved = matches.size > 1 ? "ambiguous" : (matches.values().next().value ?? "not_found");
			} else {
				const collection = byCollection.get(source.collection);
				const item = byId.get(source.collection)?.get(source.id);
				if (item && collection) resolved = { item, collection };
			}
			prepared.push({ source, resolved });
			if (typeof resolved !== "string") {
				const collectionGroups = groups.get(resolved.collection.slug) ?? new Set<string>();
				collectionGroups.add(resolved.item.translationGroup ?? resolved.item.id);
				groups.set(resolved.collection.slug, collectionGroups);
			}
		}
		const termGroup = term.translationGroup ?? term.id;
		const assigned = new Set<string>();
		if (!input.apply) {
			for (const [collection, entryGroups] of groups) {
				for (const batch of chunks([...entryGroups], 50)) {
					const rows = await db
						.selectFrom("content_taxonomies")
						.select("entry_id")
						.where("collection", "=", collection)
						.where("taxonomy_id", "=", termGroup)
						.where("entry_id", "in", batch)
						.execute();
					for (const row of rows) assigned.add(`${collection}:${row.entry_id}`);
				}
			}
		}
		const siblingIds = new Map<string, Map<string, string[]>>();
		if (input.apply && invalidate) {
			for (const [collection, entryGroups] of groups) {
				siblingIds.set(
					collection,
					await content.findTranslationIdsForGroups(collection, [...entryGroups]),
				);
			}
		}
		const seen = new Set<string>();
		const purge = new Set<string>([taxonomyTag("tag")]);
		const results: BulkTagResult[] = [];
		let changed = false;
		for (const { source, resolved } of prepared) {
			if (typeof resolved === "string") {
				if (
					input.apply &&
					input.refreshOnly &&
					invalidate &&
					"id" in source &&
					byCollection.has(source.collection)
				) {
					purge.add(source.collection);
					purge.add(source.id);
				}
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
				const inserted =
					input.apply && !input.refreshOnly
						? await taxonomy.attachGroupsToEntry(collection.slug, item.id, [termGroup])
						: 0;
				if (inserted) changed = true;
				seen.add(key);
				if (input.apply && invalidate) {
					purge.add(collection.slug);
					for (const id of siblingIds.get(collection.slug)?.get(group) ?? [item.id]) purge.add(id);
				}
				results.push({
					input: source,
					status: input.apply
						? inserted
							? "added"
							: "skipped"
						: assigned.has(key)
							? "skipped"
							: "ready",
					entry,
				});
			} catch (error) {
				console.error("[bulk-tag] Failed to tag entry:", error);
				results.push({ input: source, status: "failed", reason: "save_failed", entry });
			}
		}
		if (changed) invalidateTermCache();
		let cacheRefreshFailed = false;
		if (input.apply && invalidate && (purge.size > 1 || input.refreshOnly)) {
			try {
				for (const batch of chunks([...purge], 100)) await invalidate(batch);
			} catch (error) {
				console.error("[bulk-tag] Failed to invalidate cache:", error);
				cacheRefreshFailed = true;
			}
		}
		return { success: true, data: { results, cacheRefreshFailed } };
	} catch (error) {
		console.error("[bulk-tag] Failed:", error);
		return {
			success: false,
			error: { code: "BULK_TAG_ERROR", message: "Failed to bulk tag posts" },
		};
	}
}
