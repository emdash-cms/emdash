import { z } from "astro/zod";
import type { CollectionSchemaInfo, PluginContext, TaxonomyDefInfo } from "emdash";

import { AUTHORS } from "./authors.js";
import { updateKv } from "./kv.js";
import { URL_TEMPLATE } from "./url-template.js";

export { AUTHORS };

const DEFAULT_COLLECTIONS = new Set(["posts", "pages"]);
const TEXT_FIELD_TYPES = new Set(["string", "text", "portableText"]);

const sourceSchema = z.object({
	enabled: z.boolean(),
	/** Fields to index. Author profiles always index name and bio. */
	fields: z.array(z.string()),
	/** Public path containing `{slug}`. Collections use their own URL pattern when unset. */
	urlTemplate: z
		.string()
		.regex(URL_TEMPLATE, "Use a site path containing {slug}, such as /authors/{slug}")
		.optional(),
	/** Result priority, 0–10. */
	weight: z.number().int().min(0).max(10),
	/** Add the entry's credited author names to its searchable text. Ignored for author profiles. */
	includeAuthorNames: z.boolean().optional(),
	/** Taxonomies whose assigned terms are added to the entry's searchable text. Ignored for author profiles. */
	taxonomies: z.array(z.string()).optional(),
});

export const configSchema = z.object({
	sources: z.record(z.string(), sourceSchema),
	/**
	 * Heading of each source's results in search, so searching needs no schema
	 * lookup. Set from the schema on save; any value sent is ignored.
	 */
	labels: z.record(z.string(), z.string()).optional(),
});

export type SourceConfig = z.infer<typeof sourceSchema>;
export type Config = z.infer<typeof configSchema>;

export async function loadConfig(ctx: Pick<PluginContext, "kv">): Promise<Config | null> {
	return ctx.kv.get<Config>("config");
}

/** Applies `change` to the saved configuration without overwriting a concurrent save. */
export function updateConfig(
	ctx: Pick<PluginContext, "kv">,
	change: (config: Config | null) => Config | undefined,
): Promise<Config | null | undefined> {
	return updateKv<Config>(ctx, "config", change);
}

/**
 * The configuration offered before setup: built-in collections on, custom
 * collections off, and each collection's author names and taxonomy terms
 * added to its entries.
 */
export function defaultConfig(
	collections: CollectionSchemaInfo[],
	taxonomies: TaxonomyInfo[],
): Config {
	const sources: Record<string, SourceConfig> = {};
	for (const collection of collections) {
		if (collection.hidden) continue;
		sources[collection.slug] = {
			enabled: DEFAULT_COLLECTIONS.has(collection.slug) && collection.routable,
			fields: defaultFields(collection),
			weight: collection.slug === "posts" ? 3 : 2,
			includeAuthorNames: true,
			taxonomies: taxonomiesOf(taxonomies, collection.slug).map((taxonomy) => taxonomy.name),
		};
	}
	sources[AUTHORS] = { enabled: false, fields: [], urlTemplate: "/authors/{slug}", weight: 2 };
	return { sources, labels: resultLabels(collections) };
}

/** The search result heading of every source. */
export function resultLabels(collections: CollectionSchemaInfo[]): Record<string, string> {
	return {
		...Object.fromEntries(collections.map((collection) => [collection.slug, collection.label])),
		[AUTHORS]: "Authors",
	};
}

function defaultFields(collection: CollectionSchemaInfo): string[] {
	const searchable = collection.fields.filter((field) => field.searchable);
	const fields = searchable.length > 0 ? searchable : collection.fields;
	return fields.filter((field) => TEXT_FIELD_TYPES.has(field.type)).map((field) => field.slug);
}

/** What the settings page shows for a source it can configure. */
export interface SourceInfo {
	id: string;
	label: string;
	description: string | null;
	/** Text fields that can be indexed. Empty for author profiles, which always index name and bio. */
	fields: Array<{ slug: string; label: string }>;
}

export function describeSources(collections: CollectionSchemaInfo[]): SourceInfo[] {
	const sources = collections
		.filter((collection) => !collection.hidden)
		.map((collection) => ({
			id: collection.slug,
			label: collection.label,
			description: collection.description,
			fields: collection.fields
				.filter((field) => TEXT_FIELD_TYPES.has(field.type))
				.map((field) => ({ slug: field.slug, label: field.label })),
		}));
	return [
		...sources,
		{
			id: AUTHORS,
			label: "Author profiles",
			description: "A result for each author, linking to their profile page",
			fields: [],
		},
	];
}

/** A taxonomy whose terms can be added to entries. */
export interface TaxonomyInfo {
	name: string;
	label: string;
	/** Collections the taxonomy is attached to. */
	collections: string[];
}

/** One entry per taxonomy; definitions are stored once per locale. */
export function describeTaxonomies(definitions: TaxonomyDefInfo[]): TaxonomyInfo[] {
	const taxonomies = new Map<string, TaxonomyInfo>();
	for (const { name, label, collections } of definitions) {
		if (!taxonomies.has(name)) taxonomies.set(name, { name, label, collections });
	}
	return [...taxonomies.values()];
}

/** The taxonomies attached to a collection. */
export function taxonomiesOf(taxonomies: TaxonomyInfo[], collection: string): TaxonomyInfo[] {
	return taxonomies.filter((taxonomy) => taxonomy.collections.includes(collection));
}

export function enabledSources(config: Config): string[] {
	return Object.entries(config.sources)
		.filter(([, source]) => source.enabled)
		.map(([id]) => id);
}
