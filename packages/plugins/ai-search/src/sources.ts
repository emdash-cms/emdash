import type {
	BylineAccess,
	BylineInfo,
	CollectionSchemaInfo,
	ContentAccess,
	MediaAccess,
	PluginContentItem,
	SchemaAccess,
	TaxonomyAccess,
	TaxonomyTermInfo,
} from "emdash";

import {
	AUTHORS,
	describeTaxonomies,
	type SourceConfig,
	type TaxonomyInfo,
	taxonomiesOf,
} from "./config.js";
import {
	type ContextLine,
	entryText,
	fillTemplate,
	imageUrl,
	isPreviewUrl,
	recordDocument,
	type SearchDocument,
} from "./documents.js";

/** Why a record has no document in AI Search. */
export type Exclusion = "disabled" | "unpublished" | "no-url" | "deleted";

export type Plan = SearchDocument | Exclusion;

/** The EmDash read access sources need. */
export interface SourceDeps {
	content: Pick<ContentAccess, "get" | "list" | "getPublicUrl">;
	schema: Pick<SchemaAccess, "getCollection">;
	bylines: Pick<BylineAccess, "get" | "list" | "getEntriesBylines">;
	media: Pick<MediaAccess, "get">;
	taxonomies: Pick<TaxonomyAccess, "getAll" | "getEntryTerms">;
}

/**
 * A kind of record the index can hold: a content collection, or author
 * profiles. Everything that differs between them lives behind this interface.
 */
export interface RecordSource<R = unknown> {
	/** A page of the records that may be indexed. */
	list(limit: number, cursor?: string): Promise<{ items: R[]; cursor?: string }>;
	/** A record by id, or null when it no longer exists. */
	get(id: string): Promise<R | null>;
	idOf(record: R): string;
	titleOf(record: R): Promise<string>;
	/** The record's public path, filled from `urlTemplate` when one is given. */
	urlOf(record: R, urlTemplate: string | undefined): Promise<string | null>;
	/**
	 * Prepares to plan `records` with lookups shared across them, and returns
	 * the planner for each one. Planning a record can fail on its own.
	 */
	planner(records: R[], config: SourceConfig): Promise<Planner<R>>;
}

export interface Planner<R> {
	plan(record: R): Promise<Plan>;
}

/** Schema and taxonomy lookups shared by every source of one indexer. */
export class SourceCache {
	private collections = new Map<string, Promise<CollectionSchemaInfo | null>>();
	private taxonomyList: Promise<TaxonomyInfo[]> | undefined;

	constructor(private readonly deps: SourceDeps) {}

	collection(slug: string): Promise<CollectionSchemaInfo | null> {
		let schema = this.collections.get(slug);
		if (!schema) {
			schema = this.deps.schema.getCollection(slug);
			this.collections.set(slug, schema);
		}
		return schema;
	}

	taxonomies(): Promise<TaxonomyInfo[]> {
		this.taxonomyList ??= this.deps.taxonomies.getAll().then(describeTaxonomies);
		return this.taxonomyList;
	}
}

export function recordSource(
	deps: SourceDeps,
	id: string,
	cache = new SourceCache(deps),
): RecordSource {
	return id === AUTHORS ? authorSource(deps) : collectionSource(deps, cache, id);
}

async function authorUrl(byline: BylineInfo, template: string | undefined) {
	return template && byline.slug ? fillTemplate(template, byline.slug) : null;
}

function authorSource(deps: SourceDeps): RecordSource<BylineInfo> {
	return {
		async list(limit, cursor) {
			const page = await deps.bylines.list({ limit, cursor });
			return { items: page.items, cursor: page.hasMore ? page.cursor : undefined };
		},
		get: (id) => deps.bylines.get(id),
		idOf: (byline) => byline.id,
		titleOf: async (byline) => byline.displayName,
		urlOf: authorUrl,
		async planner(_bylines, config) {
			return {
				plan: async (byline) => {
					const url = await authorUrl(byline, config.urlTemplate);
					if (!url) return "no-url";
					const avatar = byline.avatarMediaId ? await deps.media.get(byline.avatarMediaId) : null;
					return recordDocument({
						source: AUTHORS,
						id: byline.id,
						title: byline.displayName,
						text: byline.bio ?? "",
						context: [],
						locale: byline.locale,
						url,
						image: avatar && isPreviewUrl(avatar.url) ? avatar.url : undefined,
						priority: config.weight,
					});
				},
			};
		},
	};
}

function collectionSource(
	deps: SourceDeps,
	cache: SourceCache,
	slug: string,
): RecordSource<PluginContentItem> {
	const fields = async () => {
		const schema = await cache.collection(slug);
		return {
			title: schema?.titleField ?? "title",
			/** First image field, used as the result's preview image. */
			image: schema?.fields.find((field) => field.type === "image")?.slug,
		};
	};
	const urlOf = async (entry: PluginContentItem, template: string | undefined) => {
		if (template) return entry.slug ? fillTemplate(template, entry.slug) : null;
		const url = await deps.content.getPublicUrl?.(slug, entry.id);
		return url ? new URL(url).pathname : null;
	};

	return {
		async list(limit, cursor) {
			if (!(await cache.collection(slug))) return { items: [] };
			const page = await deps.content.list(slug, {
				where: { status: "published" },
				limit,
				cursor,
			});
			return { items: page.items, cursor: page.hasMore ? page.cursor : undefined };
		},
		async get(id) {
			return (await cache.collection(slug)) ? deps.content.get(slug, id) : null;
		},
		idOf: (entry) => entry.id,
		async titleOf(entry) {
			return entryText(entry, (await fields()).title, []).title;
		},
		urlOf,
		async planner(entries, config) {
			const published = entries.filter((entry) => entry.status === "published");
			const [{ title, image }, authors] = await Promise.all([
				fields(),
				config.includeAuthorNames ? authorNames(deps, slug, published) : new Map(),
			]);
			return {
				plan: async (entry) => {
					if (entry.status !== "published") return "unpublished";
					const url = await urlOf(entry, config.urlTemplate);
					if (!url) return "no-url";
					const names = authors.get(entry.id) ?? [];
					const terms = await entryTerms(deps, cache, slug, entry, config.taxonomies ?? []);
					return recordDocument({
						source: slug,
						id: entry.id,
						...entryText(entry, title, config.fields),
						context: [...(names.length > 0 ? [{ label: "Authors", values: names }] : []), ...terms],
						locale: entry.locale ?? "",
						publishedAt: entry.publishedAt,
						url,
						image: image ? imageUrl(entry.data[image]) : undefined,
						priority: config.weight,
					});
				},
			};
		},
	};
}

async function authorNames(
	deps: SourceDeps,
	collection: string,
	entries: PluginContentItem[],
): Promise<Map<string, string[]>> {
	if (entries.length === 0) return new Map();
	const credits = await deps.bylines.getEntriesBylines(
		collection,
		entries.map((entry) => entry.id),
	);
	return new Map(
		credits.map(({ entryId, bylines }) => [
			entryId,
			bylines.map((credit) => credit.byline.displayName),
		]),
	);
}

/** The entry's terms in each included taxonomy, in the entry's locale where translated. */
async function entryTerms(
	deps: SourceDeps,
	cache: SourceCache,
	collection: string,
	entry: PluginContentItem,
	included: string[],
): Promise<ContextLine[]> {
	if (included.length === 0) return [];
	const taxonomies = taxonomiesOf(await cache.taxonomies(), collection).filter((taxonomy) =>
		included.includes(taxonomy.name),
	);
	if (taxonomies.length === 0) return [];

	const byGroup = new Map<string, TaxonomyTermInfo>();
	for (const term of await deps.taxonomies.getEntryTerms(collection, entry.id)) {
		const group = term.translationGroup ?? term.id;
		if (!byGroup.has(group) || term.locale === entry.locale) byGroup.set(group, term);
	}
	const terms = [...byGroup.values()];
	return taxonomies.map((taxonomy) => ({
		label: taxonomy.label,
		values: terms
			.filter((term) => term.taxonomy === taxonomy.name)
			.map((term) => term.label)
			.toSorted((a, b) => a.localeCompare(b)),
	}));
}
