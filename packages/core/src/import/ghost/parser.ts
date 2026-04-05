export interface GhostPost {
	id: string;
	title?: string | null;
	slug: string;
	html?: string | null;
	plaintext?: string | null;
	feature_image?: string | null;
	type: string;
	status?: string | null;
	locale?: string | null;
	visibility?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	published_at?: string | null;
	custom_excerpt?: string | null;
	excerpt?: string | null;
}

export interface GhostTag {
	id: string;
	name: string;
	slug: string;
	description?: string | null;
}

export interface GhostPostTag {
	id: string;
	post_id: string;
	tag_id: string;
	sort_order?: number | null;
}

export interface GhostUser {
	id: string;
	name?: string | null;
	slug?: string | null;
	email?: string | null;
}

export interface GhostPostAuthor {
	id: string;
	post_id: string;
	author_id: string;
	sort_order?: number | null;
}

export interface GhostSetting {
	id: string;
	group?: string | null;
	key: string;
	value?: string | null;
	type?: string | null;
	flags?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
}

export interface GhostPostMeta {
	id: string;
	post_id: string;
	feature_image_alt?: string | null;
	feature_image_caption?: string | null;
	meta_title?: string | null;
	meta_description?: string | null;
	og_title?: string | null;
	og_description?: string | null;
	twitter_title?: string | null;
	twitter_description?: string | null;
}

export interface GhostPostProduct {
	id: string;
	post_id: string;
	product_id: string;
	sort_order?: number | null;
}

export interface GhostExportData {
	posts: GhostPost[];
	tags: GhostTag[];
	postTags: GhostPostTag[];
	users: GhostUser[];
	postAuthors: GhostPostAuthor[];
	settings: GhostSetting[];
	postsMeta: GhostPostMeta[];
	postProducts: GhostPostProduct[];
}

const SORT_ORDER_FALLBACK = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringKey(record: Record<string, unknown>, key: string): boolean {
	return typeof record[key] === "string";
}

function isGhostPost(value: unknown): value is GhostPost {
	return (
		isRecord(value) &&
		hasStringKey(value, "id") &&
		hasStringKey(value, "slug") &&
		hasStringKey(value, "type")
	);
}

function isGhostTag(value: unknown): value is GhostTag {
	return (
		isRecord(value) &&
		hasStringKey(value, "id") &&
		hasStringKey(value, "name") &&
		hasStringKey(value, "slug")
	);
}

function isGhostPostTag(value: unknown): value is GhostPostTag {
	return (
		isRecord(value) &&
		hasStringKey(value, "id") &&
		hasStringKey(value, "post_id") &&
		hasStringKey(value, "tag_id")
	);
}

function isGhostUser(value: unknown): value is GhostUser {
	return isRecord(value) && hasStringKey(value, "id");
}

function isGhostPostAuthor(value: unknown): value is GhostPostAuthor {
	return (
		isRecord(value) &&
		hasStringKey(value, "id") &&
		hasStringKey(value, "post_id") &&
		hasStringKey(value, "author_id")
	);
}

function isGhostSetting(value: unknown): value is GhostSetting {
	return isRecord(value) && hasStringKey(value, "id") && hasStringKey(value, "key");
}

function isGhostPostMeta(value: unknown): value is GhostPostMeta {
	return isRecord(value) && hasStringKey(value, "id") && hasStringKey(value, "post_id");
}

function isGhostPostProduct(value: unknown): value is GhostPostProduct {
	return (
		isRecord(value) &&
		hasStringKey(value, "id") &&
		hasStringKey(value, "post_id") &&
		hasStringKey(value, "product_id")
	);
}

function getArray<T>(
	value: unknown,
	label: string,
	isItem: (entry: unknown) => entry is T,
	required = false,
): T[] {
	if (value === undefined) {
		if (required) {
			throw new Error(`Invalid Ghost export shape: ${label} not found`);
		}
		return [];
	}

	if (!Array.isArray(value)) {
		throw new Error(`Invalid Ghost export shape: ${label} must be an array`);
	}

	const result: T[] = [];
	for (const entry of value) {
		if (!isItem(entry)) {
			throw new Error(`Invalid Ghost export shape: ${label} contains an invalid row`);
		}
		result.push(entry);
	}

	return result;
}

export function parseGhostExportData(raw: unknown): GhostExportData {
	if (!isRecord(raw)) {
		throw new Error("Invalid Ghost export: expected an object");
	}

	const db = raw.db;
	if (!Array.isArray(db) || db.length === 0 || !isRecord(db[0])) {
		throw new Error("Invalid Ghost export shape: db[0] not found");
	}

	const tables = db[0].data;
	if (!isRecord(tables)) {
		throw new Error("Invalid Ghost export shape: db[0].data not found");
	}

	return {
		posts: getArray(tables.posts, "posts", isGhostPost, true),
		tags: getArray(tables.tags, "tags", isGhostTag),
		postTags: getArray(tables.posts_tags, "posts_tags", isGhostPostTag),
		users: getArray(tables.users, "users", isGhostUser),
		postAuthors: getArray(tables.posts_authors, "posts_authors", isGhostPostAuthor),
		settings: getArray(tables.settings, "settings", isGhostSetting),
		postsMeta: getArray(tables.posts_meta, "posts_meta", isGhostPostMeta),
		postProducts: getArray(tables.posts_products, "posts_products", isGhostPostProduct),
	};
}

export function parseGhostExportString(text: string): GhostExportData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`Invalid Ghost export JSON: ${error instanceof Error ? error.message : "Unknown parse error"}`,
			{ cause: error },
		);
	}

	return parseGhostExportData(parsed);
}

export function buildGhostTagSlugsByPostId(data: GhostExportData): Map<string, string[]> {
	const tagById = new Map(data.tags.map((tag) => [tag.id, tag]));
	const tagsByPostId = new Map<string, string[]>();

	for (const relation of data.postTags) {
		const tag = tagById.get(relation.tag_id);
		if (!tag?.slug) {
			continue;
		}

		const existing = tagsByPostId.get(relation.post_id) ?? [];
		if (!existing.includes(tag.slug)) {
			existing.push(tag.slug);
			tagsByPostId.set(relation.post_id, existing);
		}
	}

	return tagsByPostId;
}

export function buildGhostPrimaryAuthorByPostId(data: GhostExportData): Map<string, GhostUser> {
	const userById = new Map(data.users.map((user) => [user.id, user]));
	const relationsByPostId = new Map<string, GhostPostAuthor[]>();

	for (const relation of data.postAuthors) {
		const existing = relationsByPostId.get(relation.post_id) ?? [];
		existing.push(relation);
		relationsByPostId.set(relation.post_id, existing);
	}

	const result = new Map<string, GhostUser>();
	for (const [postId, relations] of relationsByPostId.entries()) {
		const primary = relations
			.toSorted(
				(a, b) => (a.sort_order ?? SORT_ORDER_FALLBACK) - (b.sort_order ?? SORT_ORDER_FALLBACK),
			)
			.find((relation) => userById.has(relation.author_id));
		if (primary) {
			result.set(postId, userById.get(primary.author_id)!);
		}
	}

	return result;
}

export function buildGhostAuthorPostCounts(data: GhostExportData): Map<string, number> {
	const counts = new Map<string, number>();
	for (const relation of data.postAuthors) {
		counts.set(relation.author_id, (counts.get(relation.author_id) ?? 0) + 1);
	}
	return counts;
}

export function buildGhostPostMetaByPostId(data: GhostExportData): Map<string, GhostPostMeta> {
	return new Map(data.postsMeta.map((meta) => [meta.post_id, meta]));
}

export function getGhostSettingValue(data: GhostExportData, key: string): string | undefined {
	const setting = data.settings.find((entry) => entry.key === key);
	return setting?.value ?? undefined;
}

export function sortGhostPostsByPublishedDate(posts: GhostPost[]): GhostPost[] {
	return posts.toSorted(
		(a, b) =>
			new Date(a.published_at || a.created_at || a.updated_at || 0).getTime() -
			new Date(b.published_at || b.created_at || b.updated_at || 0).getTime(),
	);
}
