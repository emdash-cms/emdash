/**
 * Populate a migrated database (and storage) with a representative origin
 * site for exporter tests: the same shape as the golden package, stored the
 * way EmDash stores it — real storage keys inside content, user ids in author
 * columns — plus everything an export must leave out: users and their
 * credentials and tokens, secrets and plugin options, comment IP hashes and
 * user agents, redirect hit counters, a media row that never finished
 * uploading, and a term assignment whose term no longer exists.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../../src/database/types.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { Storage } from "../../../src/storage/types.js";
import { fixtureId } from "./golden-package.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T10:00:00.000Z";
const T2 = "2026-03-01T12:30:00.000Z";
const FUTURE = "2027-06-01T09:00:00.000Z";
const ORIGIN = "https://origin.example";

type AnyDb = Kysely<Record<string, Record<string, unknown>>>;

/** Give every row the same columns (missing ones NULL) so multi-row inserts are valid SQL. */
/**
 * Body of an anonymous pending comment that quotes media placeholder text,
 * escapes included, and must survive a transfer unchanged.
 */
export const LITERAL_PLACEHOLDER_COMMENT =
	"Is emdash-media:01ABC a bug? Also emdash-media::x and a trailing emdash-media:";

function uniform(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return rows.map((row) =>
		Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
	);
}

export interface OriginMedia {
	id: string;
	storageKey: string;
	bytes: Uint8Array;
	status: string;
}

export interface OriginSite {
	ids: {
		alice: string;
		bob: string;
		carol: string;
		calloutBlock: string;
		quoteBlock: string;
		posts: string;
		pages: string;
		hello: string;
		bonjour: string;
		about: string;
		draftPost: string;
		scheduledPost: string;
		trashedPost: string;
		helloLive: string;
		helloDraft: string;
		aboutLive: string;
		aliceEn: string;
		aliceFr: string;
		guest: string;
		newsEn: string;
		worldEn: string;
		newsFr: string;
		featuredTag: string;
		heroMedia: string;
		inlineMedia: string;
		logoMedia: string;
		avatarMedia: string;
		pendingMedia: string;
		rootComment: string;
		replyComment: string;
		pendingComment: string;
	};
	media: OriginMedia[];
	/** Strings that must never appear anywhere in an exported package. */
	forbidden: string[];
}

const encoder = new TextEncoder();

/**
 * Build the origin site. `db` must be freshly migrated with no collections;
 * `storage` receives the media objects.
 */
export async function buildOriginSite(db: Kysely<Database>, storage: Storage): Promise<OriginSite> {
	const raw = db as unknown as AnyDb;
	const registry = new SchemaRegistry(db);

	const ids = {
		alice: fixtureId(1001),
		bob: fixtureId(1002),
		carol: fixtureId(1003),
		calloutBlock: "",
		quoteBlock: "",
		posts: "",
		pages: "",
		hello: fixtureId(1010),
		bonjour: fixtureId(1011),
		about: fixtureId(1012),
		draftPost: fixtureId(1013),
		scheduledPost: fixtureId(1014),
		trashedPost: fixtureId(1015),
		helloLive: fixtureId(1020),
		helloDraft: fixtureId(1021),
		aboutLive: fixtureId(1022),
		aliceEn: fixtureId(1030),
		aliceFr: fixtureId(1031),
		guest: fixtureId(1032),
		newsEn: fixtureId(1040),
		worldEn: fixtureId(1041),
		newsFr: fixtureId(1042),
		featuredTag: fixtureId(1043),
		heroMedia: fixtureId(1050),
		inlineMedia: fixtureId(1051),
		logoMedia: fixtureId(1052),
		avatarMedia: fixtureId(1053),
		pendingMedia: fixtureId(1054),
		rootComment: fixtureId(1060),
		replyComment: fixtureId(1061),
		pendingComment: fixtureId(1062),
	};

	const forbidden = [
		"alice-credential-public-key",
		"token-hash-secret-0001",
		"oauth-token-hash-secret-0002",
		"magic-link-hash-secret-0003",
		"preview-secret-value-0004",
		"plugin-api-key-value-0005",
		"ip-hash-value-0006",
		"Mozilla/5.0 (origin-user-agent)",
		"voter-hash-value-0007",
		"carol@example.com",
		"https://origin-site-url.example",
	];

	await raw
		.insertInto("users")
		.values(
			uniform([
				{
					id: ids.alice,
					email: "alice@example.com",
					name: "Alice Author",
					role: 50,
					email_verified: 1,
				},
				{ id: ids.bob, email: "bob@example.com", name: "Bob", role: 30, email_verified: 1 },
				{ id: ids.carol, email: "carol@example.com", name: "Carol", role: 10, email_verified: 0 },
			]),
		)
		.execute();
	await raw
		.insertInto("credentials")
		.values({
			id: "cred-alice",
			user_id: ids.alice,
			public_key: encoder.encode("alice-credential-public-key"),
			counter: 1,
			device_type: "multiDevice",
			backed_up: 1,
		})
		.execute();
	await raw
		.insertInto("_emdash_api_tokens")
		.values({
			id: "tok-1",
			name: "CI",
			token_hash: "token-hash-secret-0001",
			prefix: "ec_pat_Ab",
			user_id: ids.alice,
			scopes: JSON.stringify(["admin"]),
		})
		.execute();
	await raw
		.insertInto("_emdash_oauth_tokens")
		.values({
			token_hash: "oauth-token-hash-secret-0002",
			token_type: "access",
			user_id: ids.bob,
			scopes: JSON.stringify(["content:read"]),
			client_type: "cli",
			expires_at: FUTURE,
		})
		.execute();
	await raw
		.insertInto("auth_tokens")
		.values({
			hash: "magic-link-hash-secret-0003",
			user_id: ids.alice,
			email: "alice@example.com",
			type: "magic_link",
			expires_at: FUTURE,
		})
		.execute();
	await raw
		.insertInto("_plugin_storage")
		.values({ plugin_id: "seo-plus", collection: "cache", id: "x", data: JSON.stringify({ a: 1 }) })
		.execute();

	const blockTypes = new BlockTypeRegistry(db);
	const calloutV1 = await blockTypes.createBlockType({
		slug: "callout",
		label: "Callout",
		description: "A highlighted note",
		icon: "megaphone",
		category: "Text",
		fields: [{ slug: "text", label: "Text", type: "string", required: true }],
	});
	const calloutV2 = await blockTypes.updateBlockType("callout", {
		expectedFingerprint: calloutV1.versions[0]!.fingerprint,
		breaking: true,
		fields: [
			{ slug: "heading", label: "Heading", type: "string", required: true },
			{ slug: "image", label: "Image", type: "image" },
		],
	});
	const callout = await blockTypes.activateVersion(
		"callout",
		2,
		calloutV2.versions.find((version) => version.active)!.fingerprint,
	);
	const quote = await blockTypes.createBlockType({
		slug: "quote",
		label: "Quote",
		fields: [{ slug: "quote", label: "Quote", type: "text" }],
	});
	ids.calloutBlock = callout.id;
	ids.quoteBlock = quote.id;

	const posts = await registry.createCollection({
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		supports: ["drafts", "revisions", "seo", "scheduling"],
		urlPattern: "/blog/{slug}",
		hasSeo: true,
		commentsEnabled: true,
		group: "Content",
		sortOrder: 1,
	});
	ids.posts = posts.id;
	await registry.createField("posts", {
		slug: "title",
		label: "Title",
		type: "string",
		required: true,
		searchable: true,
	});
	await registry.createField("posts", { slug: "featured_image", label: "Image", type: "image" });
	await registry.createField("posts", { slug: "content", label: "Content", type: "portableText" });
	await registry.createField("posts", {
		slug: "gallery",
		label: "Gallery",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "photo", type: "image", label: "Photo" },
				{ slug: "caption", type: "string", label: "Caption" },
			],
		},
	});
	await registry.createField("posts", {
		slug: "related",
		label: "Related",
		type: "reference",
		indexed: true,
	});
	await registry.createField("posts", { slug: "rating", label: "Rating", type: "number" });
	await registry.createField("posts", {
		slug: "metadata",
		label: "Metadata",
		type: "json",
		translatable: false,
	});
	await registry.createField("posts", {
		slug: "blocks",
		label: "Blocks",
		type: "blocks",
		validation: { allowedTypes: ["callout"], retiredTypes: ["quote"] },
	});
	const pages = await registry.createCollection({
		slug: "pages",
		label: "Pages",
		labelSingular: "Page",
		supports: ["drafts", "revisions"],
	});
	ids.pages = pages.id;
	await registry.createField("pages", {
		slug: "title",
		label: "Title",
		type: "string",
		required: true,
	});
	await registry.createField("pages", { slug: "content", label: "Content", type: "portableText" });
	await registry.updateCollection("posts", { titleField: "title" });

	await raw
		.insertInto("_emdash_taxonomy_defs")
		.values({
			id: fixtureId(1100),
			name: "category",
			label: "Catégories",
			label_singular: "Catégorie",
			hierarchical: 1,
			collections: JSON.stringify(["posts"]),
			locale: "fr",
			translation_group: "taxdef_category",
		})
		.execute();
	await raw
		.updateTable("_emdash_taxonomy_defs")
		.set({ translation_group: "taxdef_category" })
		.where("id", "=", "taxdef_category")
		.execute();

	await raw
		.insertInto("taxonomies")
		.values(
			uniform([
				{
					id: ids.newsEn,
					name: "category",
					slug: "news",
					label: "News",
					data: JSON.stringify({ description: "All the news" }),
					locale: "en",
					translation_group: ids.newsEn,
				},
				{
					id: ids.worldEn,
					name: "category",
					slug: "world",
					label: "World",
					parent_id: ids.newsEn,
					locale: "en",
					translation_group: ids.worldEn,
				},
				{
					id: ids.newsFr,
					name: "category",
					slug: "actualites",
					label: "Actualités",
					locale: "fr",
					translation_group: ids.newsEn,
				},
				{
					id: ids.featuredTag,
					name: "tag",
					slug: "featured",
					label: "Featured",
					locale: "en",
					translation_group: ids.featuredTag,
				},
			]),
		)
		.execute();

	await raw
		.insertInto("_emdash_relations")
		.values({
			id: fixtureId(1110),
			name: "related_pages",
			parent_collection: "posts",
			child_collection: "pages",
			parent_label: "Related pages",
			child_label: "Referenced by",
			locale: "en",
			translation_group: fixtureId(1110),
		})
		.execute();

	await raw
		.insertInto("_emdash_byline_fields")
		.values(
			uniform([
				{
					id: fixtureId(1120),
					slug: "twitter",
					label: "Twitter",
					type: "string",
					translatable: 0,
					sort_order: 0,
				},
				{
					id: fixtureId(1121),
					slug: "pronouns",
					label: "Pronouns",
					type: "string",
					translatable: 1,
					sort_order: 1,
				},
			]),
		)
		.execute();

	await raw
		.insertInto("media_folders")
		.values({ id: fixtureId(1130), name: "Photos", name_key: "photos" })
		.execute();

	const media: OriginMedia[] = [
		{
			id: ids.heroMedia,
			storageKey: "01HZORIGINHEROKEY000000000.jpg",
			bytes: encoder.encode("origin hero"),
			status: "ready",
		},
		{
			id: ids.inlineMedia,
			storageKey: "01HZORIGININLINEKEY0000000.png",
			bytes: encoder.encode("origin inline"),
			status: "ready",
		},
		{
			id: ids.logoMedia,
			storageKey: "01HZORIGINLOGOKEY000000000.svg",
			bytes: encoder.encode("<svg/>"),
			status: "ready",
		},
		{
			id: ids.avatarMedia,
			storageKey: "01HZORIGINAVATARKEY0000000.jpg",
			bytes: encoder.encode("origin hero"),
			status: "ready",
		},
		{
			id: ids.pendingMedia,
			storageKey: "01HZORIGINPENDINGKEY000000.jpg",
			bytes: encoder.encode("half"),
			status: "pending",
		},
	];
	for (const item of media) {
		if (item.status === "ready") {
			await storage.upload({
				key: item.storageKey,
				body: item.bytes,
				contentType: "application/octet-stream",
			});
		}
		forbidden.push(item.storageKey);
	}
	await raw
		.insertInto("media")
		.values(
			media.map((item, index) => ({
				id: item.id,
				filename: `file-${index}${item.storageKey.slice(item.storageKey.lastIndexOf("."))}`,
				mime_type: item.storageKey.endsWith(".svg") ? "image/svg+xml" : "image/jpeg",
				size: item.bytes.byteLength,
				width: 1600,
				height: 900,
				focal_x: index === 0 ? 0.25 : null,
				focal_y: index === 0 ? 0.75 : null,
				alt: `Alt ${index}`,
				storage_key: item.storageKey,
				content_hash: `hash-${index}`,
				status: item.status,
				author_id: index === 2 ? ids.bob : ids.alice,
				folder_id: index === 0 ? fixtureId(1130) : null,
				created_at: T0,
			})),
		)
		.execute();

	const keyOf = (mediaId: string) => media.find((item) => item.id === mediaId)!.storageKey;
	const imageValue = (mediaId: string) => ({
		id: mediaId,
		provider: "local",
		mimeType: "image/jpeg",
		width: 1600,
		height: 900,
		meta: { storageKey: keyOf(mediaId) },
	});
	const legacyImageValue = (mediaId: string) => ({ id: keyOf(mediaId), provider: "local" });
	const portableText = () => [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [
				{
					_type: "link",
					_key: "l1",
					href: `${ORIGIN}/_emdash/api/media/file/${keyOf(ids.inlineMedia)}`,
				},
			],
			children: [{ _type: "span", _key: "s1", text: "Hello", marks: ["l1"] }],
		},
		{
			_type: "image",
			_key: "i1",
			asset: { _ref: ids.inlineMedia, url: `/_emdash/api/media/file/${keyOf(ids.inlineMedia)}` },
		},
		{
			_type: "gallery",
			_key: "g1",
			images: [
				{
					_key: "gi1",
					asset: { _ref: ids.heroMedia, url: `/_emdash/api/media/file/${keyOf(ids.heroMedia)}` },
				},
			],
		},
	];

	const blocksValue = () => [
		{
			_type: "callout",
			_version: 2,
			_key: "c1",
			heading: "Read this first",
			image: imageValue(ids.inlineMedia),
		},
		{ _type: "callout", _version: 1, _key: "c2", text: "An older callout" },
		{ _type: "quote", _version: 1, _key: "q1", quote: "Retired but kept" },
	];

	await raw
		.insertInto("_emdash_bylines")
		.values(
			uniform([
				{
					id: ids.aliceEn,
					slug: "alice",
					display_name: "Alice Author",
					bio: "Writes things.",
					avatar_media_id: ids.avatarMedia,
					website_url: "https://alice.example",
					user_id: ids.alice,
					is_guest: 0,
					locale: "en",
					translation_group: ids.aliceEn,
					created_at: T0,
					updated_at: T0,
				},
				{
					id: ids.aliceFr,
					slug: "alice",
					display_name: "Alice Autrice",
					user_id: null,
					is_guest: 0,
					locale: "fr",
					translation_group: ids.aliceEn,
					created_at: T0,
					updated_at: T0,
				},
				{
					id: ids.guest,
					slug: "guest-writer",
					display_name: "Guest Writer",
					is_guest: 1,
					locale: "en",
					translation_group: ids.guest,
					created_at: T0,
					updated_at: T0,
				},
			]),
		)
		.execute();
	await raw
		.insertInto("_emdash_byline_field_values")
		.values({ byline_id: ids.aliceEn, field_id: fixtureId(1121), value: JSON.stringify("she/her") })
		.execute();
	await raw
		.insertInto("_emdash_byline_field_group_values")
		.values({
			translation_group: ids.aliceEn,
			field_id: fixtureId(1120),
			value: JSON.stringify("@alice"),
		})
		.execute();

	await raw
		.insertInto("revisions")
		.values(
			uniform([
				{
					id: ids.helloLive,
					collection: "posts",
					entry_id: ids.hello,
					data: JSON.stringify({
						title: "Hello world",
						content: portableText(),
						featured_image: imageValue(ids.heroMedia),
						blocks: blocksValue(),
					}),
					author_id: ids.alice,
					created_at: T1,
				},
				{
					id: ids.helloDraft,
					collection: "posts",
					entry_id: ids.hello,
					data: JSON.stringify({
						title: "Hello world (edited)",
						featured_image: legacyImageValue(ids.heroMedia),
					}),
					author_id: ids.bob,
					created_at: T2,
				},
				{
					id: ids.aboutLive,
					collection: "pages",
					entry_id: ids.about,
					data: JSON.stringify({ title: "About" }),
					author_id: ids.alice,
					created_at: T1,
				},
			]),
		)
		.execute();

	const postRow = (row: Record<string, unknown>) => ({
		status: "published",
		version: 1,
		created_at: T0,
		updated_at: T1,
		...row,
	});
	// One row per statement: a multi-row insert of every post exceeds D1's bound-parameter limit.
	for (const row of uniform([
		postRow({
			id: ids.hello,
			slug: "hello-world",
			author_id: ids.alice,
			primary_byline_id: ids.aliceEn,
			published_at: T1,
			updated_at: T2,
			version: 3,
			live_revision_id: ids.helloLive,
			draft_revision_id: ids.helloDraft,
			locale: "en",
			translation_group: ids.hello,
			title: "Hello world",
			featured_image: JSON.stringify(imageValue(ids.heroMedia)),
			content: JSON.stringify(portableText()),
			gallery: JSON.stringify([{ photo: imageValue(ids.heroMedia), caption: "One" }]),
			related: ids.about,
			rating: 4.5,
			metadata: JSON.stringify({ reading: { minutes: 3 } }),
			blocks: JSON.stringify(blocksValue()),
		}),
		postRow({
			id: ids.bonjour,
			slug: "bonjour-le-monde",
			author_id: ids.bob,
			published_at: T1,
			locale: "fr",
			translation_group: ids.hello,
			title: "Bonjour le monde",
			featured_image: keyOf(ids.heroMedia),
		}),
		postRow({
			id: ids.draftPost,
			slug: "work-in-progress",
			status: "draft",
			author_id: ids.alice,
			locale: "en",
			translation_group: ids.draftPost,
			title: "Work in progress",
		}),
		postRow({
			id: ids.scheduledPost,
			slug: "coming-soon",
			status: "scheduled",
			author_id: ids.bob,
			scheduled_at: FUTURE,
			locale: "en",
			translation_group: ids.scheduledPost,
			title: "Coming soon",
		}),
		postRow({
			id: ids.trashedPost,
			slug: "old-news",
			author_id: ids.alice,
			published_at: T0,
			deleted_at: T2,
			locale: "en",
			translation_group: ids.trashedPost,
			title: "Old news",
		}),
	])) {
		await raw
			.insertInto("ec_posts")
			.values({ ...row, blocks: row.blocks ?? "[]" })
			.execute();
	}
	await raw
		.insertInto("ec_pages")
		.values(
			postRow({
				id: ids.about,
				slug: "about",
				author_id: ids.alice,
				published_at: T1,
				live_revision_id: ids.aboutLive,
				locale: "en",
				translation_group: ids.about,
				title: "About",
				content: JSON.stringify([]),
			}),
		)
		.execute();

	await raw
		.insertInto("content_taxonomies")
		.values(
			uniform([
				{ collection: "posts", entry_id: ids.hello, taxonomy_id: ids.newsEn },
				{ collection: "posts", entry_id: ids.hello, taxonomy_id: ids.featuredTag },
				{ collection: "posts", entry_id: ids.draftPost, taxonomy_id: ids.worldEn },
				{ collection: "posts", entry_id: ids.hello, taxonomy_id: fixtureId(1999) },
			]),
		)
		.execute();
	await raw
		.insertInto("_emdash_content_bylines")
		.values(
			uniform([
				{
					id: fixtureId(1200),
					collection_slug: "posts",
					content_id: ids.hello,
					byline_id: ids.aliceEn,
					sort_order: 0,
					created_at: T1,
				},
				{
					id: fixtureId(1201),
					collection_slug: "posts",
					content_id: ids.hello,
					byline_id: ids.guest,
					sort_order: 1,
					role_label: "Photographer",
					created_at: T1,
				},
			]),
		)
		.execute();
	await raw
		.insertInto("_emdash_content_references")
		.values({
			id: fixtureId(1210),
			relation_group: fixtureId(1110),
			parent_group: ids.hello,
			child_group: ids.about,
			sort_order: 0,
			created_at: T1,
		})
		.execute();
	await raw
		.insertInto("_emdash_seo")
		.values({
			collection: "posts",
			content_id: ids.hello,
			seo_title: "Hello",
			seo_image: keyOf(ids.heroMedia),
			seo_no_index: 0,
			created_at: T1,
			updated_at: T1,
		})
		.execute();

	await raw
		.insertInto("_emdash_menus")
		.values(
			uniform([
				{
					id: fixtureId(1300),
					name: "primary",
					label: "Primary",
					locale: "en",
					translation_group: fixtureId(1300),
				},
				{
					id: fixtureId(1301),
					name: "primary",
					label: "Principal",
					locale: "fr",
					translation_group: fixtureId(1300),
				},
			]),
		)
		.execute();
	await raw
		.insertInto("_emdash_menu_items")
		.values(
			uniform([
				{
					id: fixtureId(1310),
					menu_id: fixtureId(1300),
					sort_order: 0,
					type: "custom",
					custom_url: "/",
					label: "Home",
					locale: "en",
					translation_group: fixtureId(1310),
				},
				{
					id: fixtureId(1311),
					menu_id: fixtureId(1300),
					sort_order: 1,
					type: "page",
					reference_collection: "pages",
					reference_id: ids.about,
					label: "About",
					locale: "en",
					translation_group: fixtureId(1311),
				},
				{
					id: fixtureId(1312),
					menu_id: fixtureId(1300),
					parent_id: fixtureId(1311),
					sort_order: 0,
					type: "custom",
					custom_url: "https://team.example",
					label: "Team",
					locale: "en",
					translation_group: fixtureId(1312),
				},
			]),
		)
		.execute();
	await raw
		.insertInto("_emdash_widget_areas")
		.values({ id: fixtureId(1320), name: "sidebar", label: "Sidebar" })
		.execute();
	await raw
		.insertInto("_emdash_widgets")
		.values(
			uniform([
				{
					id: fixtureId(1321),
					area_id: fixtureId(1320),
					sort_order: 0,
					type: "content",
					title: "Promo",
					content: JSON.stringify([
						{
							_type: "image",
							_key: "w1",
							asset: {
								_ref: ids.inlineMedia,
								url: `/_emdash/api/media/file/${keyOf(ids.inlineMedia)}`,
							},
						},
					]),
				},
				{
					id: fixtureId(1322),
					area_id: fixtureId(1320),
					sort_order: 1,
					type: "menu",
					title: "Navigate",
					menu_name: "primary",
				},
			]),
		)
		.execute();
	await raw
		.insertInto("_emdash_sections")
		.values({
			id: fixtureId(1330),
			slug: "hero-banner",
			title: "Hero banner",
			content: JSON.stringify([]),
			preview_media_id: ids.heroMedia,
			source: "user",
		})
		.execute();

	await raw
		.insertInto("_emdash_redirects")
		.values({
			id: fixtureId(1340),
			source: "/old-blog/[...path]",
			destination: "/blog/[...path]",
			type: 301,
			is_pattern: 1,
			enabled: 1,
			hits: 42,
			last_hit_at: T2,
			auto: 0,
			created_at: T0,
			updated_at: T0,
		})
		.execute();

	await raw
		.insertInto("_emdash_comments")
		.values(
			uniform([
				{
					id: ids.rootComment,
					collection: "posts",
					content_id: ids.hello,
					author_name: "Bob",
					author_email: "bob@example.com",
					author_user_id: ids.bob,
					body: "Great post!",
					status: "approved",
					ip_hash: "ip-hash-value-0006",
					user_agent: "Mozilla/5.0 (origin-user-agent)",
					created_at: T1,
					updated_at: T1,
				},
				{
					id: ids.replyComment,
					collection: "posts",
					content_id: ids.hello,
					parent_id: ids.rootComment,
					author_name: "Visitor",
					author_email: "visitor@example.net",
					body: "Agreed.",
					status: "approved",
					ip_hash: "ip-hash-value-0006",
					created_at: T2,
					updated_at: T2,
				},
				{
					id: ids.pendingComment,
					collection: "posts",
					content_id: ids.hello,
					author_name: "Anonymous",
					author_email: "anon@example.net",
					body: LITERAL_PLACEHOLDER_COMMENT,
					status: "pending",
					ip_hash: "ip-hash-value-0006",
					created_at: T2,
					updated_at: T2,
				},
			]),
		)
		.execute();
	await raw
		.insertInto("_emdash_comment_reactions")
		.values({
			id: fixtureId(1350),
			comment_id: ids.rootComment,
			reaction: "like",
			voter_hash: "voter-hash-value-0007",
			created_at: T1,
		})
		.execute();

	const option = (name: string, value: unknown) => ({ name, value: JSON.stringify(value) });
	await raw
		.insertInto("options")
		.values(
			uniform([
				option("site:title", "Origin Site"),
				option("site:tagline", "Where it all began"),
				option("site:logo", { mediaId: ids.logoMedia, alt: "Logo" }),
				option("site:seo", { titleSeparator: " | ", defaultOgImage: { mediaId: ids.heroMedia } }),
				option("site:url", "https://origin-site-url.example"),
				option("emdash:site_url", "https://origin-site-url.example"),
				option("emdash:site_title", "Origin Site"),
				option("emdash:setup_complete", true),
				option("emdash:preview_secret", "preview-secret-value-0004"),
				option("plugin:seo-plus:api_key", "plugin-api-key-value-0005"),
			]),
		)
		.onConflict((conflict) => conflict.column("name").doNothing())
		.execute();

	return { ids, media, forbidden };
}
