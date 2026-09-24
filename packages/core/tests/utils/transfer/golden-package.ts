/**
 * A hand-written site package covering every record kind, built in code (not
 * by the exporter) so importer and analyzer tests have an independent
 * reference. Cross-references are realistic: two locales with translations,
 * drafts with draft revisions, scheduled and trashed entries, a term
 * hierarchy, an inferred byline credit, media referenced from Portable Text,
 * image fields, repeaters, a blocks field whose values use every version of
 * its block types, SEO and settings, threaded comments with reactions.
 *
 * Storage-key references appear only as `emdash-media:<mediaId>`
 * placeholders, exactly as an exporter writes them.
 */

import type { Storage } from "../../../src/storage/types.js";
import type { Sha256Digest } from "../../../src/transfer/format/digest.js";
import { compareIds } from "../../../src/transfer/format/kinds.js";
import type {
	RecordKind,
	SitePackageRecord,
	TopologicalKind,
} from "../../../src/transfer/format/kinds.js";
import { RECORD_KINDS, TOPOLOGICAL_PARENT_PROPERTY } from "../../../src/transfer/format/kinds.js";
import type { SitePackageManifest } from "../../../src/transfer/format/manifest.js";
import { PackageAssembler } from "../../../src/transfer/staging/assembler.js";
import { StagedPackageReader, StagedPackageWriter } from "../../../src/transfer/staging/package.js";
import { TransferStage } from "../../../src/transfer/staging/stage.js";

/** Deterministic ULID-shaped id: `01HZ` + 22 digits. */
export function fixtureId(n: number): string {
	return `01HZ${String(n).padStart(22, "0")}`;
}

export const GOLDEN_IDS = {
	originSiteId: fixtureId(1),
	packageId: fixtureId(2),

	alice: "user_alice",
	bob: "user_bob",

	calloutBlock: fixtureId(90),
	calloutV1: fixtureId(91),
	calloutV2: fixtureId(92),
	quoteBlock: fixtureId(93),
	quoteV1: fixtureId(94),

	posts: fixtureId(100),
	pages: fixtureId(101),

	postTitle: fixtureId(110),
	postFeaturedImage: fixtureId(111),
	postContent: fixtureId(112),
	postGallery: fixtureId(113),
	postRelated: fixtureId(114),
	postRating: fixtureId(115),
	postMetadata: fixtureId(116),
	postBlocks: fixtureId(117),
	pageTitle: fixtureId(120),
	pageContent: fixtureId(121),

	categoryEn: fixtureId(130),
	categoryFr: fixtureId(131),
	tagEn: fixtureId(132),

	relatedPages: fixtureId(140),

	bylineTwitter: fixtureId(150),
	bylinePronouns: fixtureId(151),

	photosFolder: fixtureId(160),

	heroMedia: fixtureId(170),
	inlineMedia: fixtureId(171),
	logoMedia: fixtureId(172),
	avatarMedia: fixtureId(173),

	newsEn: fixtureId(180),
	worldEn: fixtureId(181),
	newsFr: fixtureId(182),
	featuredTag: fixtureId(183),

	aliceEn: fixtureId(190),
	aliceFr: fixtureId(191),
	guest: fixtureId(192),

	helloLive: fixtureId(200),
	helloDraft: fixtureId(201),
	aboutLive: fixtureId(202),
	bonjourLive: fixtureId(203),

	hello: fixtureId(210),
	bonjour: fixtureId(211),
	about: fixtureId(212),
	draftPost: fixtureId(213),
	scheduledPost: fixtureId(214),
	trashedPost: fixtureId(215),

	creditAlice: fixtureId(220),
	creditGuest: fixtureId(221),

	relatedRef: fixtureId(230),

	primaryEn: fixtureId(240),
	primaryFr: fixtureId(241),
	homeItem: fixtureId(242),
	aboutItem: fixtureId(243),
	teamItem: fixtureId(244),
	accueilItem: fixtureId(245),

	sidebar: fixtureId(250),
	promoWidget: fixtureId(251),
	menuWidget: fixtureId(252),

	heroSection: fixtureId(260),

	oldBlogRedirect: fixtureId(270),

	rootComment: fixtureId(280),
	replyComment: fixtureId(281),
	nestedReply: fixtureId(282),

	reactionOne: fixtureId(290),
	reactionTwo: fixtureId(291),
} as const;

const ids = GOLDEN_IDS;
const encoder = new TextEncoder();

/** Media bytes by media id. The avatar shares the hero's bytes, so two media records name one blob. */
export const GOLDEN_MEDIA_BYTES: Readonly<Record<string, Uint8Array>> = {
	[ids.heroMedia]: encoder.encode("golden hero image bytes"),
	[ids.inlineMedia]: encoder.encode("golden inline png bytes"),
	[ids.logoMedia]: encoder.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
	[ids.avatarMedia]: encoder.encode("golden hero image bytes"),
};

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T10:00:00.000Z";
const T2 = "2026-03-01T12:30:00.000Z";
const FUTURE = "2027-06-01T09:00:00.000Z";

function placeholder(mediaId: string): string {
	return `emdash-media:${mediaId}`;
}

function imageValue(mediaId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: mediaId,
		provider: "local",
		mimeType: "image/jpeg",
		width: 1600,
		height: 900,
		alt: "A hero",
		meta: { storageKey: placeholder(mediaId) },
		...extra,
	};
}

function portableText(): unknown[] {
	return [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [
				{
					_type: "link",
					_key: "l1",
					href: `https://origin.example/_emdash/api/media/file/${placeholder(ids.inlineMedia)}`,
				},
			],
			children: [
				{ _type: "span", _key: "s1", text: "Hello ", marks: [] },
				{ _type: "span", _key: "s2", text: "download", marks: ["l1"] },
			],
		},
		{
			_type: "image",
			_key: "i1",
			asset: {
				_ref: ids.inlineMedia,
				url: `/_emdash/api/media/file/${placeholder(ids.inlineMedia)}`,
			},
			alt: "Inline",
		},
		{
			_type: "gallery",
			_key: "g1",
			images: [
				{
					_key: "gi1",
					asset: {
						_ref: ids.heroMedia,
						url: `/_emdash/api/media/file/${placeholder(ids.heroMedia)}`,
					},
				},
			],
		},
	];
}

/** A `blocks` field value: the current callout, a callout kept at version 1, and a retired quote. */
function blocksValue(): unknown[] {
	return [
		{
			_type: "callout",
			_version: 2,
			_key: "c1",
			heading: "Read this first",
			body: [
				{
					_type: "block",
					_key: "cb1",
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: "cs1", text: "Inside a block", marks: [] }],
				},
			],
			image: imageValue(ids.inlineMedia, { alt: "Callout" }),
		},
		{ _type: "callout", _version: 1, _key: "c2", text: "An older callout" },
		{ _type: "quote", _version: 1, _key: "q1", quote: "Retired but kept", tone: "cool" },
	];
}

function revisionData(title: string): Record<string, unknown> {
	return {
		title,
		content: portableText(),
		featured_image: imageValue(ids.heroMedia),
		blocks: blocksValue(),
	};
}

/**
 * Every record of the golden package, grouped by kind (unsorted). `blobs`
 * maps each media id to its blob digest.
 */
export function goldenRecords(
	blobs: ReadonlyMap<string, string>,
): Record<RecordKind, SitePackageRecord[]> {
	const records: Record<RecordKind, SitePackageRecord[]> = Object.fromEntries(
		RECORD_KINDS.map((kind) => [kind, []]),
	) as unknown as Record<RecordKind, SitePackageRecord[]>;
	const add = (record: SitePackageRecord) => records[record.kind].push(record);

	add({
		kind: "principal",
		id: ids.alice,
		displayName: "Alice Author",
		email: "alice@example.com",
	});
	add({ kind: "principal", id: ids.bob, displayName: "Bob" });

	add({
		kind: "block_type",
		id: ids.calloutBlock,
		slug: "callout",
		label: "Callout",
		description: "A highlighted note",
		icon: "megaphone",
		category: "Text",
		currentVersion: 2,
		source: "user",
		createdAt: T0,
		updatedAt: T1,
	});
	add({
		kind: "block_type_version",
		id: ids.calloutV1,
		blockTypeId: ids.calloutBlock,
		version: 1,
		fields: [{ slug: "text", label: "Text", type: "string", required: true }],
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "block_type_version",
		id: ids.calloutV2,
		blockTypeId: ids.calloutBlock,
		version: 2,
		fields: [
			{ slug: "heading", label: "Heading", type: "string", required: true },
			{ slug: "body", label: "Body", type: "portableText" },
			{ slug: "image", label: "Image", type: "image", options: { darkVariant: true } },
		],
		createdAt: T1,
		updatedAt: T1,
	});
	add({
		kind: "block_type",
		id: ids.quoteBlock,
		slug: "quote",
		label: "Quote",
		currentVersion: 1,
		source: "user",
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "block_type_version",
		id: ids.quoteV1,
		blockTypeId: ids.quoteBlock,
		version: 1,
		fields: [
			{ slug: "quote", label: "Quote", type: "text", validation: { maxLength: 500 } },
			{
				slug: "tone",
				label: "Tone",
				type: "select",
				validation: { options: ["warm", "cool"] },
				defaultValue: "warm",
			},
		],
		createdAt: T0,
		updatedAt: T0,
	});

	add({
		kind: "collection",
		id: ids.posts,
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		supports: ["drafts", "revisions", "search", "seo", "scheduling"],
		source: "manual",
		searchConfig: { enabled: true, weights: { title: 10 } },
		hasSeo: true,
		urlPattern: "/blog/{slug}",
		commentsEnabled: true,
		commentsModeration: "first_time",
		commentsClosedAfterDays: 90,
		commentsAutoApproveUsers: true,
		hidden: false,
		sortOrder: 1,
		adminConfig: { listColumns: ["title"] },
		titleField: "title",
		dateField: "published_at",
		routable: true,
		editLocking: true,
		navGroup: "Content",
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "collection",
		id: ids.pages,
		slug: "pages",
		label: "Pages",
		labelSingular: "Page",
		supports: ["drafts", "revisions"],
		source: "manual",
		hasSeo: false,
		commentsEnabled: false,
		commentsModeration: "first_time",
		commentsClosedAfterDays: 90,
		commentsAutoApproveUsers: true,
		hidden: false,
		routable: true,
		editLocking: true,
		createdAt: T0,
		updatedAt: T0,
	});

	const field = (
		id: string,
		collectionId: string,
		slug: string,
		type: string,
		columnType: "TEXT" | "REAL" | "INTEGER" | "JSON",
		sortOrder: number,
		extra: Partial<Extract<SitePackageRecord, { kind: "field" }>> = {},
	) =>
		add({
			kind: "field",
			id,
			collectionId,
			slug,
			label: slug,
			type,
			columnType,
			required: false,
			unique: false,
			sortOrder,
			searchable: false,
			translatable: true,
			indexed: false,
			createdAt: T0,
			...extra,
		});
	field(ids.postTitle, ids.posts, "title", "string", "TEXT", 0, {
		required: true,
		searchable: true,
	});
	field(ids.postFeaturedImage, ids.posts, "featured_image", "image", "TEXT", 1);
	field(ids.postContent, ids.posts, "content", "portableText", "JSON", 2, { searchable: true });
	field(ids.postGallery, ids.posts, "gallery", "repeater", "JSON", 3, {
		validation: {
			subFields: [
				{ slug: "photo", type: "image", label: "Photo" },
				{ slug: "caption", type: "string", label: "Caption" },
			],
		},
	});
	field(ids.postRelated, ids.posts, "related", "reference", "TEXT", 4, {
		options: { collection: "pages" },
		indexed: true,
	});
	field(ids.postRating, ids.posts, "rating", "number", "REAL", 5, { defaultValue: 0 });
	field(ids.postMetadata, ids.posts, "metadata", "json", "JSON", 6, { translatable: false });
	field(ids.postBlocks, ids.posts, "blocks", "blocks", "JSON", 7, {
		defaultValue: [],
		validation: {
			allowedTypes: ["callout"],
			retiredTypes: ["quote"],
			minItems: 0,
			maxItems: 100,
		},
	});
	field(ids.pageTitle, ids.pages, "title", "string", "TEXT", 0, { required: true });
	field(ids.pageContent, ids.pages, "content", "portableText", "JSON", 1);

	add({
		kind: "taxonomy_def",
		id: ids.categoryEn,
		name: "category",
		label: "Categories",
		labelSingular: "Category",
		hierarchical: true,
		collections: ["posts"],
		locale: "en",
		translationGroup: ids.categoryEn,
		createdAt: T0,
	});
	add({
		kind: "taxonomy_def",
		id: ids.categoryFr,
		name: "category",
		label: "Catégories",
		labelSingular: "Catégorie",
		hierarchical: true,
		collections: ["posts"],
		locale: "fr",
		translationGroup: ids.categoryEn,
		createdAt: T0,
	});
	add({
		kind: "taxonomy_def",
		id: ids.tagEn,
		name: "tag",
		label: "Tags",
		labelSingular: "Tag",
		hierarchical: false,
		collections: ["posts"],
		locale: "en",
		translationGroup: ids.tagEn,
		createdAt: T0,
	});

	add({
		kind: "relation",
		id: ids.relatedPages,
		name: "related_pages",
		parentCollection: "posts",
		childCollection: "pages",
		parentLabel: "Related pages",
		childLabel: "Referenced by",
		locale: "en",
		translationGroup: ids.relatedPages,
		createdAt: T0,
		updatedAt: T0,
	});

	add({
		kind: "byline_field",
		id: ids.bylineTwitter,
		slug: "twitter",
		label: "Twitter",
		type: "string",
		required: false,
		translatable: false,
		sortOrder: 0,
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "byline_field",
		id: ids.bylinePronouns,
		slug: "pronouns",
		label: "Pronouns",
		type: "select",
		required: false,
		translatable: true,
		validation: { options: ["she/her", "elle", "they/them"] },
		sortOrder: 1,
		createdAt: T0,
		updatedAt: T0,
	});

	add({ kind: "media_folder", id: ids.photosFolder, name: "Photos", nameKey: "photos" });

	const media = (
		id: string,
		filename: string,
		mimeType: string,
		extra: Partial<Extract<SitePackageRecord, { kind: "media" }>>,
	) =>
		add({
			kind: "media",
			id,
			filename,
			mimeType,
			size: GOLDEN_MEDIA_BYTES[id]!.byteLength,
			createdAt: T0,
			blob: blobs.get(id)!,
			...extra,
		});
	media(ids.heroMedia, "hero.jpg", "image/jpeg", {
		width: 1600,
		height: 900,
		focalX: 0.25,
		focalY: 0.75,
		alt: "A hero",
		caption: "The hero image",
		blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
		dominantColor: "#336699",
		authorPrincipal: ids.alice,
		folderId: ids.photosFolder,
	});
	media(ids.inlineMedia, "inline.png", "image/png", { width: 800, height: 600 });
	media(ids.logoMedia, "logo.svg", "image/svg+xml", { authorPrincipal: ids.bob });
	media(ids.avatarMedia, "avatar.jpg", "image/jpeg", { width: 1600, height: 900 });

	add({
		kind: "term",
		id: ids.newsEn,
		name: "category",
		slug: "news",
		label: "News",
		data: { description: "All the news" },
		locale: "en",
		translationGroup: ids.newsEn,
		sortOrder: 0,
	});
	add({
		kind: "term",
		id: ids.worldEn,
		name: "category",
		slug: "world",
		label: "World",
		parentId: ids.newsEn,
		locale: "en",
		translationGroup: ids.worldEn,
		sortOrder: 0,
	});
	add({
		kind: "term",
		id: ids.newsFr,
		name: "category",
		slug: "actualites",
		label: "Actualités",
		locale: "fr",
		translationGroup: ids.newsEn,
		sortOrder: 0,
	});
	add({
		kind: "term",
		id: ids.featuredTag,
		name: "tag",
		slug: "featured",
		label: "Featured",
		locale: "en",
		translationGroup: ids.featuredTag,
		sortOrder: 0,
	});

	add({
		kind: "byline",
		id: ids.aliceEn,
		slug: "alice",
		displayName: "Alice Author",
		bio: "Writes things.",
		avatarMediaId: ids.avatarMedia,
		websiteUrl: "https://alice.example",
		userPrincipal: ids.alice,
		isGuest: false,
		locale: "en",
		translationGroup: ids.aliceEn,
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "byline",
		id: ids.aliceFr,
		slug: "alice",
		displayName: "Alice Autrice",
		isGuest: false,
		locale: "fr",
		translationGroup: ids.aliceEn,
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "byline",
		id: ids.guest,
		slug: "guest-writer",
		displayName: "Guest Writer",
		isGuest: true,
		locale: "en",
		translationGroup: ids.guest,
		createdAt: T0,
		updatedAt: T0,
	});

	add({
		kind: "byline_field_value",
		id: `${ids.aliceEn}:${ids.bylinePronouns}`,
		bylineId: ids.aliceEn,
		fieldId: ids.bylinePronouns,
		value: "she/her",
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "byline_field_value",
		id: `${ids.aliceFr}:${ids.bylinePronouns}`,
		bylineId: ids.aliceFr,
		fieldId: ids.bylinePronouns,
		value: "elle",
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "byline_field_group_value",
		id: `${ids.aliceEn}:${ids.bylineTwitter}`,
		bylineGroup: ids.aliceEn,
		fieldId: ids.bylineTwitter,
		value: "@alice",
		createdAt: T0,
		updatedAt: T0,
	});

	add({
		kind: "revision",
		id: ids.helloLive,
		collection: "posts",
		entryId: ids.hello,
		data: revisionData("Hello world"),
		authorPrincipal: ids.alice,
		createdAt: T1,
	});
	add({
		kind: "revision",
		id: ids.helloDraft,
		collection: "posts",
		entryId: ids.hello,
		data: revisionData("Hello world (edited)"),
		authorPrincipal: ids.bob,
		createdAt: T2,
	});
	add({
		kind: "revision",
		id: ids.aboutLive,
		collection: "pages",
		entryId: ids.about,
		data: { title: "About", content: [] },
		authorPrincipal: ids.alice,
		createdAt: T1,
	});
	add({
		kind: "revision",
		id: ids.bonjourLive,
		collection: "posts",
		entryId: ids.bonjour,
		data: revisionData("Bonjour le monde"),
		createdAt: T1,
	});

	const postFields = (title: string) => ({
		title,
		featured_image: JSON.stringify(imageValue(ids.heroMedia)),
		content: portableText(),
		gallery: [{ photo: imageValue(ids.heroMedia, { alt: "Gallery" }), caption: "One" }],
		related: ids.about,
		rating: 4.5,
		metadata: { reading: { minutes: 3 }, tags: ["a", "b"] },
		blocks: blocksValue(),
	});

	add({
		kind: "entry",
		id: ids.hello,
		collection: "posts",
		slug: "hello-world",
		status: "published",
		authorPrincipal: ids.alice,
		primaryBylineGroup: ids.aliceEn,
		createdAt: T0,
		updatedAt: T2,
		publishedAt: T1,
		version: 3,
		liveRevisionId: ids.helloLive,
		draftRevisionId: ids.helloDraft,
		locale: "en",
		translationGroup: ids.hello,
		fields: postFields("Hello world"),
	});
	add({
		kind: "entry",
		id: ids.bonjour,
		collection: "posts",
		slug: "bonjour-le-monde",
		status: "published",
		authorPrincipal: ids.bob,
		createdAt: T0,
		updatedAt: T1,
		publishedAt: T1,
		version: 1,
		liveRevisionId: ids.bonjourLive,
		locale: "fr",
		translationGroup: ids.hello,
		fields: { title: "Bonjour le monde", content: [], rating: 3, blocks: [] },
	});
	add({
		kind: "entry",
		id: ids.about,
		collection: "pages",
		slug: "about",
		status: "published",
		authorPrincipal: ids.alice,
		createdAt: T0,
		updatedAt: T1,
		publishedAt: T1,
		version: 1,
		liveRevisionId: ids.aboutLive,
		locale: "en",
		translationGroup: ids.about,
		fields: { title: "About", content: [] },
	});
	add({
		kind: "entry",
		id: ids.draftPost,
		collection: "posts",
		slug: "work-in-progress",
		status: "draft",
		authorPrincipal: ids.alice,
		createdAt: T2,
		updatedAt: T2,
		version: 1,
		locale: "en",
		translationGroup: ids.draftPost,
		fields: { title: "Work in progress", blocks: [] },
	});
	add({
		kind: "entry",
		id: ids.scheduledPost,
		collection: "posts",
		slug: "coming-soon",
		status: "scheduled",
		authorPrincipal: ids.bob,
		createdAt: T2,
		updatedAt: T2,
		scheduledAt: FUTURE,
		version: 1,
		locale: "en",
		translationGroup: ids.scheduledPost,
		fields: { title: "Coming soon", blocks: [] },
	});
	add({
		kind: "entry",
		id: ids.trashedPost,
		collection: "posts",
		slug: "old-news",
		status: "published",
		authorPrincipal: ids.alice,
		createdAt: T0,
		updatedAt: T2,
		publishedAt: T0,
		deletedAt: T2,
		version: 2,
		locale: "en",
		translationGroup: ids.trashedPost,
		fields: { title: "Old news", blocks: [] },
	});

	add({
		kind: "content_term",
		id: `posts:${ids.hello}:${ids.newsEn}`,
		collection: "posts",
		entryGroup: ids.hello,
		termGroup: ids.newsEn,
	});
	add({
		kind: "content_term",
		id: `posts:${ids.hello}:${ids.featuredTag}`,
		collection: "posts",
		entryGroup: ids.hello,
		termGroup: ids.featuredTag,
	});
	add({
		kind: "content_term",
		id: `posts:${ids.draftPost}:${ids.worldEn}`,
		collection: "posts",
		entryGroup: ids.draftPost,
		termGroup: ids.worldEn,
	});

	add({
		kind: "content_byline",
		id: ids.creditAlice,
		collection: "posts",
		entryId: ids.hello,
		bylineGroup: ids.aliceEn,
		sortOrder: 0,
		createdAt: T1,
	});
	add({
		kind: "content_byline",
		id: ids.creditGuest,
		collection: "posts",
		entryId: ids.hello,
		bylineGroup: ids.guest,
		sortOrder: 1,
		roleLabel: "Photographer",
		createdAt: T1,
	});

	add({
		kind: "content_reference",
		id: ids.relatedRef,
		relationGroup: ids.relatedPages,
		parentGroup: ids.hello,
		childGroup: ids.about,
		sortOrder: 0,
		createdAt: T1,
	});

	add({
		kind: "seo",
		id: `posts:${ids.hello}`,
		collection: "posts",
		entryId: ids.hello,
		seoTitle: "Hello world | Golden",
		seoDescription: "The first post",
		seoImage: placeholder(ids.heroMedia),
		seoCanonical: "/blog/hello-world",
		seoNoIndex: false,
		createdAt: T1,
		updatedAt: T1,
	});

	add({
		kind: "menu",
		id: ids.primaryEn,
		name: "primary",
		label: "Primary",
		locale: "en",
		translationGroup: ids.primaryEn,
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "menu",
		id: ids.primaryFr,
		name: "primary",
		label: "Principal",
		locale: "fr",
		translationGroup: ids.primaryEn,
		createdAt: T0,
		updatedAt: T0,
	});
	add({
		kind: "menu_item",
		id: ids.homeItem,
		menuId: ids.primaryEn,
		sortOrder: 0,
		type: "custom",
		customUrl: "/",
		label: "Home",
		locale: "en",
		translationGroup: ids.homeItem,
		createdAt: T0,
	});
	add({
		kind: "menu_item",
		id: ids.aboutItem,
		menuId: ids.primaryEn,
		sortOrder: 1,
		type: "page",
		referenceCollection: "pages",
		referenceGroup: ids.about,
		label: "About",
		titleAttr: "About us",
		cssClasses: "nav-about",
		locale: "en",
		translationGroup: ids.aboutItem,
		createdAt: T0,
	});
	add({
		kind: "menu_item",
		id: ids.teamItem,
		menuId: ids.primaryEn,
		parentId: ids.aboutItem,
		sortOrder: 0,
		type: "custom",
		customUrl: "https://team.example",
		label: "Team",
		target: "_blank",
		locale: "en",
		translationGroup: ids.teamItem,
		createdAt: T0,
	});
	add({
		kind: "menu_item",
		id: ids.accueilItem,
		menuId: ids.primaryFr,
		sortOrder: 0,
		type: "custom",
		customUrl: "/fr/",
		label: "Accueil",
		locale: "fr",
		translationGroup: ids.homeItem,
		createdAt: T0,
	});

	add({
		kind: "widget_area",
		id: ids.sidebar,
		name: "sidebar",
		label: "Sidebar",
		description: "Main sidebar",
		createdAt: T0,
	});
	add({
		kind: "widget",
		id: ids.promoWidget,
		areaId: ids.sidebar,
		sortOrder: 0,
		type: "content",
		title: "Promo",
		content: [
			{
				_type: "image",
				_key: "w1",
				asset: {
					_ref: ids.inlineMedia,
					url: `/_emdash/api/media/file/${placeholder(ids.inlineMedia)}`,
				},
			},
		],
		createdAt: T0,
	});
	add({
		kind: "widget",
		id: ids.menuWidget,
		areaId: ids.sidebar,
		sortOrder: 1,
		type: "menu",
		title: "Navigate",
		menuName: "primary",
		createdAt: T0,
	});

	add({
		kind: "section",
		id: ids.heroSection,
		slug: "hero-banner",
		title: "Hero banner",
		description: "A reusable hero",
		keywords: ["hero", "banner"],
		content: [
			{
				_type: "image",
				_key: "s1",
				asset: {
					_ref: ids.heroMedia,
					url: `/_emdash/api/media/file/${placeholder(ids.heroMedia)}`,
				},
			},
		],
		previewMediaId: ids.heroMedia,
		source: "user",
		createdAt: T0,
		updatedAt: T0,
	});

	add({
		kind: "redirect",
		id: ids.oldBlogRedirect,
		source: "/old-blog/[...path]",
		destination: "/blog/[...path]",
		type: 301,
		isPattern: true,
		enabled: true,
		groupName: "migration",
		auto: false,
		createdAt: T0,
		updatedAt: T0,
	});

	add({
		kind: "comment",
		id: ids.rootComment,
		collection: "posts",
		entryId: ids.hello,
		authorName: "Bob",
		authorEmail: "bob@example.com",
		authorPrincipal: ids.bob,
		body: "Great post!",
		status: "approved",
		moderationMetadata: { checkedBy: "auto" },
		createdAt: T1,
		updatedAt: T1,
	});
	add({
		kind: "comment",
		id: ids.replyComment,
		collection: "posts",
		entryId: ids.hello,
		parentId: ids.rootComment,
		authorName: "Visitor",
		authorEmail: "visitor@example.net",
		body: "Agreed.",
		status: "approved",
		createdAt: T2,
		updatedAt: T2,
	});
	add({
		kind: "comment",
		id: ids.nestedReply,
		collection: "posts",
		entryId: ids.hello,
		parentId: ids.replyComment,
		authorName: "Spammer",
		authorEmail: "spam@example.org",
		body: "Buy now",
		status: "spam",
		createdAt: T2,
		updatedAt: T2,
	});

	add({
		kind: "comment_reaction",
		id: ids.reactionOne,
		commentId: ids.rootComment,
		reaction: "like",
		createdAt: T1,
	});
	add({
		kind: "comment_reaction",
		id: ids.reactionTwo,
		commentId: ids.rootComment,
		reaction: "like",
		createdAt: T2,
	});

	add({ kind: "setting", id: "site:title", value: "Golden Site" });
	add({ kind: "setting", id: "site:tagline", value: "A package for tests" });
	add({ kind: "setting", id: "site:logo", value: { mediaId: ids.logoMedia, alt: "Golden logo" } });
	add({
		kind: "setting",
		id: "site:seo",
		value: { titleSeparator: " | ", defaultOgImage: { mediaId: ids.heroMedia } },
	});
	add({ kind: "setting", id: "site:postsPerPage", value: 10 });
	add({ kind: "setting", id: "emdash:site_title", value: "Golden Site" });

	return records;
}

/** Topological depth of a record in its kind (0 for flat kinds and roots). */
function depthOf(
	kind: RecordKind,
	record: SitePackageRecord,
	byId: Map<string, SitePackageRecord>,
): number {
	if (!Object.hasOwn(TOPOLOGICAL_PARENT_PROPERTY, kind)) return 0;
	const property = TOPOLOGICAL_PARENT_PROPERTY[kind as TopologicalKind];
	let depth = 0;
	let current: SitePackageRecord | undefined = record;
	for (;;) {
		const parent = (current as Record<string, unknown>)[property];
		if (typeof parent !== "string") return depth;
		current = byId.get(parent);
		if (!current) return depth + 1;
		depth++;
	}
}

/** Records of a kind in package stream order, with depths for topological kinds. */
export function inStreamOrder(
	kind: RecordKind,
	records: readonly SitePackageRecord[],
): Array<{ record: SitePackageRecord; depth: number }> {
	const byId = new Map(records.map((record) => [record.id, record]));
	return records
		.map((record) => ({ record, depth: depthOf(kind, record, byId) }))
		.toSorted((a, b) => a.depth - b.depth || compareIds(a.record.id, b.record.id));
}

export interface GoldenPackage {
	manifest: SitePackageManifest;
	digest: Sha256Digest;
	stage: TransferStage;
	reader: StagedPackageReader;
	/** Every record by kind, in stream order, with media blob digests filled in. */
	records: Record<RecordKind, SitePackageRecord[]>;
	/** Blob digest by media id. */
	blobs: Map<string, string>;
}

/**
 * Build the golden package and stage it under `prefix` in `storage`.
 * Deterministic: the same call always produces the same digest.
 */
export async function buildGoldenPackage(
	storage: Storage,
	options: { prefix?: string } = {},
): Promise<GoldenPackage> {
	const stage = new TransferStage(storage, options.prefix ?? "transfers/fixtures/golden/");
	const assembler = new PackageAssembler(new StagedPackageWriter(stage));

	const blobs = new Map<string, string>();
	for (const [mediaId, bytes] of Object.entries(GOLDEN_MEDIA_BYTES)) {
		blobs.set(mediaId, await assembler.addBlob(bytes));
	}

	const grouped = goldenRecords(blobs);
	const ordered = {} as Record<RecordKind, SitePackageRecord[]>;
	for (const kind of RECORD_KINDS) {
		ordered[kind] = [];
		for (const { record, depth } of inStreamOrder(kind, grouped[kind])) {
			await assembler.addRecord(record, { depth });
			ordered[kind].push(record);
		}
	}

	const { manifest, digest } = await assembler.finish({
		packageId: ids.packageId,
		originSiteId: ids.originSiteId,
		createdAt: "2026-04-01T00:00:00.000Z",
		createdByEmDashVersion: "0.0.0-golden",
		defaultLocale: "en",
		transformations: [{ code: "redirect_duplicate_dropped", kind: "redirect", count: 1 }],
	});
	return {
		manifest,
		digest,
		stage,
		reader: new StagedPackageReader(stage),
		records: ordered,
		blobs,
	};
}
