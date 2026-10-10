import type {
	BylineInfo,
	CollectionSchemaInfo,
	KVAccess,
	MediaAccess,
	PluginContentItem,
	TaxonomyDefInfo,
	TaxonomyTermInfo,
} from "emdash";

import type { Config } from "../src/config.js";
import type { IndexerDeps } from "../src/indexer.js";
import type { SnapshotRow, SnapshotStore } from "../src/snapshot.js";

export function entry(overrides: Partial<PluginContentItem> = {}): PluginContentItem {
	return {
		id: "entry-1",
		type: "posts",
		slug: "hello-world",
		status: "published",
		locale: "en",
		data: { title: "Hello world", excerpt: "A first post", content: "Body text" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		publishedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function term(overrides: Partial<TaxonomyTermInfo> = {}): TaxonomyTermInfo {
	return {
		id: "term-1",
		taxonomy: "tag",
		slug: "gardening",
		label: "Gardening",
		parentId: null,
		data: null,
		locale: "en",
		translationGroup: "term-1",
		...overrides,
	};
}

export function taxonomy(overrides: Partial<TaxonomyDefInfo> = {}): TaxonomyDefInfo {
	return {
		name: "tag",
		label: "Tags",
		labelSingular: "Tag",
		hierarchical: false,
		collections: ["posts"],
		locale: "en",
		...overrides,
	};
}

export function byline(overrides: Partial<BylineInfo> = {}): BylineInfo {
	return {
		id: "byline-1",
		slug: "jane-doe",
		displayName: "Jane Doe",
		bio: "Writes about gardens.",
		websiteUrl: null,
		avatarMediaId: null,
		locale: "en",
		translationGroup: "byline-1",
		...overrides,
	};
}

export function config(overrides: Partial<Config> = {}): Config {
	return {
		sources: {
			posts: {
				enabled: true,
				fields: ["title", "excerpt", "content"],
				weight: 3,
				includeAuthorNames: true,
				taxonomies: ["tag"],
			},
			_authors: { enabled: true, fields: [], urlTemplate: "/authors/{slug}", weight: 2 },
		},
		...overrides,
	};
}

const POSTS = { slug: "posts", titleField: "title", fields: [] } as unknown as CollectionSchemaInfo;

/** Content, schema, byline, media, and taxonomy access backed by fixed records. */
export function fakeEmDash(records: {
	entries?: PluginContentItem[];
	bylines?: BylineInfo[];
	collections?: CollectionSchemaInfo[];
	media?: Array<NonNullable<Awaited<ReturnType<MediaAccess["get"]>>>>;
	taxonomies?: TaxonomyDefInfo[];
	/** Terms assigned to every entry. */
	terms?: TaxonomyTermInfo[];
}) {
	const entries = records.entries ?? [];
	const bylines = records.bylines ?? [];
	const deps: Omit<IndexerDeps, "items"> = {
		snapshot: memorySnapshot(),
		content: {
			get: async (_collection, id) => entries.find((item) => item.id === id) ?? null,
			list: async (_collection, options) => {
				const matching = entries.filter(
					(item) => !options?.where?.status || item.status === options.where.status,
				);
				const start = Number(options?.cursor ?? 0);
				const end = start + (options?.limit ?? 50);
				const hasMore = end < matching.length;
				return {
					items: matching.slice(start, end),
					hasMore,
					cursor: hasMore ? String(end) : undefined,
				};
			},
			getPublicUrl: async (collection, id) => {
				const item = entries.find((candidate) => candidate.id === id);
				return item?.slug ? `https://example.com/${collection}/${item.slug}` : null;
			},
		},
		schema: {
			getCollection: async (slug) =>
				(records.collections ?? [POSTS]).find((collection) => collection.slug === slug) ?? null,
		},
		media: {
			get: async (id) => records.media?.find((item) => item.id === id) ?? null,
		},
		taxonomies: {
			getAll: async () => records.taxonomies ?? [],
			getEntryTerms: async () => records.terms ?? [],
		},
		bylines: {
			get: async (id) => bylines.find((item) => item.id === id) ?? null,
			list: async () => ({ items: bylines, hasMore: false }),
			getEntriesBylines: async (_collection, ids) =>
				ids.map((entryId) => ({
					entryId,
					bylines: bylines.map((item, sortOrder) => ({
						byline: item,
						sortOrder,
						roleLabel: null,
						source: "explicit" as const,
					})),
				})),
		},
	};
	return deps;
}

/** D1 binds at most 100 parameters; batch storage calls bind two besides the ids. */
function checkBindLimit(ids: string[]) {
	if (ids.length + 2 > 100) throw new Error("D1_ERROR: too many SQL variables");
}

/** Plugin storage for the build snapshot, with D1's bind limit. */
export function memorySnapshot(): SnapshotStore & { rows: Map<string, SnapshotRow> } {
	const rows = new Map<string, SnapshotRow>();
	return {
		rows,
		getMany: async (ids) => {
			checkBindLimit(ids);
			return new Map(
				ids.flatMap((id) => {
					const row = rows.get(id);
					return row ? [[id, row] as const] : [];
				}),
			);
		},
		putMany: async (items) => {
			for (const { id, data } of items) rows.set(id, data);
		},
		query: async (options) => {
			const source = options?.where?.source;
			const matching = [...rows].filter(([, row]) => row.source === source);
			const items = matching.slice(0, options?.limit ?? 50).map(([id, data]) => ({ id, data }));
			return { items, hasMore: matching.length > items.length };
		},
		deleteMany: async (ids) => {
			checkBindLimit(ids);
			return ids.filter((id) => rows.delete(id)).length;
		},
	};
}

/** KV with the host's conditional-write semantics: every write gets a new revision. */
export function memoryKv(): KVAccess {
	const values = new Map<string, { value: unknown; revision: string }>();
	let revisions = 0;
	const write = (key: string, value: unknown) => {
		const revision = String(++revisions);
		values.set(key, { value: structuredClone(value), revision });
		return revision;
	};
	return {
		get: async <T>(key: string) => (values.get(key)?.value as T | undefined) ?? null,
		getVersioned: async <T>(key: string) => {
			const stored = values.get(key);
			return stored ? { value: stored.value as T, revision: stored.revision } : null;
		},
		set: async (key, value) => void write(key, value),
		compareAndSet: async (key, expected, value) =>
			(values.get(key)?.revision ?? null) === expected
				? { applied: true, revision: write(key, value) }
				: { applied: false },
		compareAndDelete: async (key, expected) => ({
			applied: values.get(key)?.revision === expected && values.delete(key),
		}),
		delete: async (key) => values.delete(key),
		list: async () => [],
	};
}
