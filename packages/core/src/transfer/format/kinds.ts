/**
 * Record kinds of a site package and their strict schemas.
 *
 * Every record is `{ kind, id, ...fields }`. Column names become camelCase
 * properties. A nullable column whose value is SQL `NULL` is represented by
 * omitting the property (never by `null`); `null` inside a JSON value is JSON
 * `null`. Integer 0/1 flag columns become booleans. JSON columns hold the
 * parsed JSON value; TEXT columns hold the stored string verbatim, even when
 * that string is itself JSON (image and file field values).
 *
 * Portable references are the origin's own ids. Columns that store a
 * translation group rather than a row id are named `…Group`. Columns holding
 * an origin user id are `…Principal` and refer to a `principal` record.
 *
 * Stream order: records of a kind appear in ascending `id` order
 * ({@link compareIds}) except the topological kinds (`term`, `comment`,
 * `menu_item`), which are ordered by `(depth, id)` where a root has depth 0
 * and a child's depth is its parent's plus one — so every parent precedes its
 * children and the order is still unique and reproducible.
 */

import { z } from "zod";

import { compareUtf16 } from "./canonical.js";
import { summarizeSchemaIssue } from "./issues.js";
import { TRANSFER_LIMITS } from "./limits.js";
import { PORTABLE_SETTING_NAMES } from "./settings.js";

export const RECORD_KINDS = [
	"principal",
	"block_type",
	"block_type_version",
	"collection",
	"field",
	"taxonomy_def",
	"relation",
	"byline_field",
	"media_folder",
	"media",
	"term",
	"byline",
	"byline_field_value",
	"byline_field_group_value",
	"revision",
	"entry",
	"content_term",
	"content_byline",
	"content_reference",
	"seo",
	"menu",
	"menu_item",
	"widget_area",
	"widget",
	"section",
	"redirect",
	"comment",
	"comment_reaction",
	"setting",
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

const RECORD_KIND_SET: ReadonlySet<string> = new Set(RECORD_KINDS);

export function isRecordKind(value: string): value is RecordKind {
	return RECORD_KIND_SET.has(value);
}

/** Position of a kind in package (and import) order. */
export function recordKindIndex(kind: RecordKind): number {
	return RECORD_KINDS.indexOf(kind);
}

/** UTF-16 code unit comparison — the only id ordering the format uses. */
export function compareIds(a: string, b: string): number {
	return compareUtf16(a, b);
}

export type StreamOrder = "id" | "topological";

export const TOPOLOGICAL_PARENT_PROPERTY = Object.freeze({
	term: "parentId",
	comment: "parentId",
	menu_item: "parentId",
} as const);

export type TopologicalKind = keyof typeof TOPOLOGICAL_PARENT_PROPERTY;

export function streamOrderOf(kind: RecordKind): StreamOrder {
	return Object.hasOwn(TOPOLOGICAL_PARENT_PROPERTY, kind) ? "topological" : "id";
}

export interface StreamOrderKey {
	id: string;
	/** Required for topological kinds; ignored otherwise. */
	depth?: number;
}

/** Stream-order comparison within one kind. */
export function compareStreamOrder(kind: RecordKind, a: StreamOrderKey, b: StreamOrderKey): number {
	if (streamOrderOf(kind) === "topological") {
		const depthA = a.depth ?? 0;
		const depthB = b.depth ?? 0;
		if (depthA !== depthB) return depthA < depthB ? -1 : 1;
	}
	return compareIds(a.id, b.id);
}

// ── Primitive schemas ───────────────────────────────────────────

/**
 * Portable ids are printable ASCII without spaces. This keeps UTF-16, UTF-8
 * byte, SQLite BINARY, and Postgres `COLLATE "C"` orderings identical.
 */
const PORTABLE_ID_PATTERN = /^[\x21-\x7e]+$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const portableIdSchema = z
	.string()
	.min(1)
	.max(TRANSFER_LIMITS.idLength)
	.regex(PORTABLE_ID_PATTERN, "Invalid portable id");

/** Collection and field slugs become SQL identifiers on the target. */
export const identifierSchema = z.string().min(1).max(63).regex(IDENTIFIER_PATTERN);

const shortString = z.string().max(TRANSFER_LIMITS.shortString);
const longText = z.string();
const timestamp = z.string().min(1).max(64);
const localeSchema = z.string().min(1).max(64);
const integer = z.number().int();
const real = z.number();
const jsonValue = z.json();
const sha256Hex = z.string().regex(SHA256_HEX_PATTERN);

// ── Record schemas ──────────────────────────────────────────────

export const principalRecordSchema = z.strictObject({
	kind: z.literal("principal"),
	id: portableIdSchema,
	displayName: shortString,
	email: shortString.optional(),
});

export const blockTypeRecordSchema = z.strictObject({
	kind: z.literal("block_type"),
	id: portableIdSchema,
	slug: identifierSchema,
	label: shortString,
	description: longText.optional(),
	icon: shortString.optional(),
	category: shortString.optional(),
	currentVersion: integer,
	source: shortString,
	createdAt: timestamp,
	updatedAt: timestamp,
});

/** The version's `fingerprint` is derived from `fields` and recomputed by the importer. */
export const blockTypeVersionRecordSchema = z.strictObject({
	kind: z.literal("block_type_version"),
	id: portableIdSchema,
	blockTypeId: portableIdSchema,
	version: integer,
	fields: z.array(jsonValue),
	createdAt: timestamp,
	updatedAt: timestamp,
});

export const collectionRecordSchema = z.strictObject({
	kind: z.literal("collection"),
	id: portableIdSchema,
	slug: identifierSchema,
	label: shortString,
	labelSingular: shortString.optional(),
	description: longText.optional(),
	icon: shortString.optional(),
	supports: z.array(shortString).optional(),
	source: shortString.optional(),
	searchConfig: jsonValue.optional(),
	hasSeo: z.boolean(),
	urlPattern: shortString.optional(),
	commentsEnabled: z.boolean().optional(),
	commentsModeration: shortString.optional(),
	commentsClosedAfterDays: integer.optional(),
	commentsAutoApproveUsers: z.boolean().optional(),
	hidden: z.boolean(),
	sortOrder: integer.optional(),
	adminConfig: jsonValue.optional(),
	titleField: shortString.optional(),
	dateField: shortString.optional(),
	routable: z.boolean(),
	editLocking: z.boolean(),
	navGroup: shortString.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const fieldRecordSchema = z.strictObject({
	kind: z.literal("field"),
	id: portableIdSchema,
	collectionId: portableIdSchema,
	slug: identifierSchema,
	label: shortString,
	type: shortString,
	columnType: z.enum(["TEXT", "REAL", "INTEGER", "JSON"]),
	required: z.boolean().optional(),
	unique: z.boolean().optional(),
	defaultValue: jsonValue.optional(),
	validation: jsonValue.optional(),
	widget: shortString.optional(),
	options: jsonValue.optional(),
	sortOrder: integer.optional(),
	searchable: z.boolean().optional(),
	translatable: z.boolean(),
	indexed: z.boolean(),
	createdAt: timestamp.optional(),
});

export const taxonomyDefRecordSchema = z.strictObject({
	kind: z.literal("taxonomy_def"),
	id: portableIdSchema,
	name: shortString.min(1),
	label: shortString,
	labelSingular: shortString.optional(),
	hierarchical: z.boolean().optional(),
	collections: z.array(shortString).optional(),
	locale: localeSchema,
	translationGroup: portableIdSchema.optional(),
	createdAt: timestamp.optional(),
});

export const relationRecordSchema = z.strictObject({
	kind: z.literal("relation"),
	id: portableIdSchema,
	slug: shortString.min(1),
	parentCollection: identifierSchema,
	childCollection: identifierSchema,
	parentLabel: shortString,
	childLabel: shortString,
	parentLabelSingular: shortString.optional(),
	childLabelSingular: shortString.optional(),
	maxChildrenPerParent: integer.optional(),
	maxParentsPerChild: integer.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const bylineFieldRecordSchema = z.strictObject({
	kind: z.literal("byline_field"),
	id: portableIdSchema,
	slug: shortString.min(1),
	label: shortString,
	type: shortString,
	required: z.boolean(),
	translatable: z.boolean(),
	validation: jsonValue.optional(),
	sortOrder: integer,
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const mediaFolderRecordSchema = z.strictObject({
	kind: z.literal("media_folder"),
	id: portableIdSchema,
	name: shortString,
	nameKey: shortString,
});

export const mediaRecordSchema = z.strictObject({
	kind: z.literal("media"),
	id: portableIdSchema,
	filename: shortString,
	mimeType: shortString,
	size: integer.optional(),
	width: integer.optional(),
	height: integer.optional(),
	focalX: real.optional(),
	focalY: real.optional(),
	alt: longText.optional(),
	caption: longText.optional(),
	blurhash: shortString.optional(),
	dominantColor: shortString.optional(),
	authorPrincipal: portableIdSchema.optional(),
	folderId: portableIdSchema.optional(),
	createdAt: timestamp.optional(),
	/** Hex SHA-256 of the bytes, stored at `media/<blob>`. */
	blob: sha256Hex,
});

export const termRecordSchema = z.strictObject({
	kind: z.literal("term"),
	id: portableIdSchema,
	name: shortString.min(1),
	slug: shortString.min(1),
	label: shortString,
	parentId: portableIdSchema.optional(),
	data: jsonValue.optional(),
	locale: localeSchema,
	translationGroup: portableIdSchema.optional(),
	sortOrder: integer,
});

export const bylineRecordSchema = z.strictObject({
	kind: z.literal("byline"),
	id: portableIdSchema,
	slug: shortString.min(1),
	displayName: shortString,
	bio: longText.optional(),
	avatarMediaId: portableIdSchema.optional(),
	websiteUrl: shortString.optional(),
	userPrincipal: portableIdSchema.optional(),
	isGuest: z.boolean(),
	locale: localeSchema,
	translationGroup: portableIdSchema.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const bylineFieldValueRecordSchema = z.strictObject({
	kind: z.literal("byline_field_value"),
	id: portableIdSchema,
	bylineId: portableIdSchema,
	fieldId: portableIdSchema,
	value: jsonValue.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const bylineFieldGroupValueRecordSchema = z.strictObject({
	kind: z.literal("byline_field_group_value"),
	id: portableIdSchema,
	bylineGroup: portableIdSchema,
	fieldId: portableIdSchema,
	value: jsonValue.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const revisionRecordSchema = z.strictObject({
	kind: z.literal("revision"),
	id: portableIdSchema,
	collection: identifierSchema,
	entryId: portableIdSchema,
	data: jsonValue,
	authorPrincipal: portableIdSchema.optional(),
	createdAt: timestamp.optional(),
});

export const entryRecordSchema = z.strictObject({
	kind: z.literal("entry"),
	id: portableIdSchema,
	collection: identifierSchema,
	slug: shortString.optional(),
	status: shortString.optional(),
	authorPrincipal: portableIdSchema.optional(),
	primaryBylineGroup: portableIdSchema.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
	publishedAt: timestamp.optional(),
	scheduledAt: timestamp.optional(),
	deletedAt: timestamp.optional(),
	version: integer.optional(),
	liveRevisionId: portableIdSchema.optional(),
	draftRevisionId: portableIdSchema.optional(),
	locale: localeSchema,
	translationGroup: portableIdSchema.optional(),
	/**
	 * Field column values keyed by field slug; NULL columns are omitted. TEXT
	 * columns are strings, INTEGER/REAL columns numbers, JSON columns parsed
	 * JSON.
	 */
	fields: z.record(identifierSchema, jsonValue),
});

export const contentTermRecordSchema = z.strictObject({
	kind: z.literal("content_term"),
	id: portableIdSchema,
	collection: identifierSchema,
	entryGroup: portableIdSchema,
	termGroup: portableIdSchema,
});

export const contentBylineRecordSchema = z.strictObject({
	kind: z.literal("content_byline"),
	id: portableIdSchema,
	collection: identifierSchema,
	entryId: portableIdSchema,
	bylineGroup: portableIdSchema,
	sortOrder: integer,
	roleLabel: shortString.optional(),
	createdAt: timestamp.optional(),
});

export const contentReferenceRecordSchema = z.strictObject({
	kind: z.literal("content_reference"),
	id: portableIdSchema,
	relationId: portableIdSchema,
	parentGroup: portableIdSchema,
	childGroup: portableIdSchema,
	sortOrder: integer,
	createdAt: timestamp.optional(),
});

export const seoRecordSchema = z.strictObject({
	kind: z.literal("seo"),
	id: portableIdSchema,
	collection: identifierSchema,
	entryId: portableIdSchema,
	seoTitle: longText.optional(),
	seoDescription: longText.optional(),
	seoImage: longText.optional(),
	seoCanonical: longText.optional(),
	seoNoIndex: z.boolean(),
	createdAt: timestamp,
	updatedAt: timestamp,
});

export const menuRecordSchema = z.strictObject({
	kind: z.literal("menu"),
	id: portableIdSchema,
	name: shortString.min(1),
	label: shortString,
	locale: localeSchema,
	translationGroup: portableIdSchema.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const menuItemRecordSchema = z.strictObject({
	kind: z.literal("menu_item"),
	id: portableIdSchema,
	menuId: portableIdSchema,
	parentId: portableIdSchema.optional(),
	sortOrder: integer,
	type: shortString,
	referenceCollection: shortString.optional(),
	referenceGroup: portableIdSchema.optional(),
	customUrl: longText.optional(),
	label: shortString,
	titleAttr: shortString.optional(),
	target: shortString.optional(),
	cssClasses: shortString.optional(),
	locale: localeSchema,
	translationGroup: portableIdSchema.optional(),
	createdAt: timestamp.optional(),
});

export const widgetAreaRecordSchema = z.strictObject({
	kind: z.literal("widget_area"),
	id: portableIdSchema,
	name: shortString.min(1),
	label: shortString,
	description: longText.optional(),
	createdAt: timestamp.optional(),
});

export const widgetRecordSchema = z.strictObject({
	kind: z.literal("widget"),
	id: portableIdSchema,
	areaId: portableIdSchema,
	sortOrder: integer,
	type: shortString,
	title: shortString.optional(),
	content: jsonValue.optional(),
	menuName: shortString.optional(),
	componentId: shortString.optional(),
	componentProps: jsonValue.optional(),
	createdAt: timestamp.optional(),
});

export const sectionRecordSchema = z.strictObject({
	kind: z.literal("section"),
	id: portableIdSchema,
	slug: shortString.min(1),
	title: shortString,
	description: longText.optional(),
	keywords: jsonValue.optional(),
	content: jsonValue,
	previewMediaId: portableIdSchema.optional(),
	source: shortString,
	themeId: shortString.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const redirectRecordSchema = z.strictObject({
	kind: z.literal("redirect"),
	id: portableIdSchema,
	source: longText.min(1),
	destination: longText,
	type: integer,
	isPattern: z.boolean(),
	enabled: z.boolean(),
	groupName: shortString.optional(),
	auto: z.boolean(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const commentRecordSchema = z.strictObject({
	kind: z.literal("comment"),
	id: portableIdSchema,
	collection: identifierSchema,
	entryId: portableIdSchema,
	parentId: portableIdSchema.optional(),
	authorName: shortString,
	authorEmail: shortString,
	authorPrincipal: portableIdSchema.optional(),
	body: longText,
	status: shortString,
	moderationMetadata: jsonValue.optional(),
	createdAt: timestamp.optional(),
	updatedAt: timestamp.optional(),
});

export const commentReactionRecordSchema = z.strictObject({
	kind: z.literal("comment_reaction"),
	id: portableIdSchema,
	commentId: portableIdSchema,
	reaction: shortString.min(1),
	createdAt: timestamp.optional(),
});

export const settingRecordSchema = z.strictObject({
	kind: z.literal("setting"),
	id: z.enum(PORTABLE_SETTING_NAMES),
	value: jsonValue,
});

export type PrincipalRecord = z.infer<typeof principalRecordSchema>;
export type BlockTypeRecord = z.infer<typeof blockTypeRecordSchema>;
export type BlockTypeVersionRecord = z.infer<typeof blockTypeVersionRecordSchema>;
export type CollectionRecord = z.infer<typeof collectionRecordSchema>;
export type FieldRecord = z.infer<typeof fieldRecordSchema>;
export type TaxonomyDefRecord = z.infer<typeof taxonomyDefRecordSchema>;
export type RelationRecord = z.infer<typeof relationRecordSchema>;
export type BylineFieldRecord = z.infer<typeof bylineFieldRecordSchema>;
export type MediaFolderRecord = z.infer<typeof mediaFolderRecordSchema>;
export type MediaRecord = z.infer<typeof mediaRecordSchema>;
export type TermRecord = z.infer<typeof termRecordSchema>;
export type BylineRecord = z.infer<typeof bylineRecordSchema>;
export type BylineFieldValueRecord = z.infer<typeof bylineFieldValueRecordSchema>;
export type BylineFieldGroupValueRecord = z.infer<typeof bylineFieldGroupValueRecordSchema>;
export type RevisionRecord = z.infer<typeof revisionRecordSchema>;
export type EntryRecord = z.infer<typeof entryRecordSchema>;
export type ContentTermRecord = z.infer<typeof contentTermRecordSchema>;
export type ContentBylineRecord = z.infer<typeof contentBylineRecordSchema>;
export type ContentReferenceRecord = z.infer<typeof contentReferenceRecordSchema>;
export type SeoRecord = z.infer<typeof seoRecordSchema>;
export type MenuRecord = z.infer<typeof menuRecordSchema>;
export type MenuItemRecord = z.infer<typeof menuItemRecordSchema>;
export type WidgetAreaRecord = z.infer<typeof widgetAreaRecordSchema>;
export type WidgetRecord = z.infer<typeof widgetRecordSchema>;
export type SectionRecord = z.infer<typeof sectionRecordSchema>;
export type RedirectRecord = z.infer<typeof redirectRecordSchema>;
export type CommentRecord = z.infer<typeof commentRecordSchema>;
export type CommentReactionRecord = z.infer<typeof commentReactionRecordSchema>;
export type SettingRecord = z.infer<typeof settingRecordSchema>;

export const RECORD_SCHEMAS = Object.freeze({
	principal: principalRecordSchema,
	block_type: blockTypeRecordSchema,
	block_type_version: blockTypeVersionRecordSchema,
	collection: collectionRecordSchema,
	field: fieldRecordSchema,
	taxonomy_def: taxonomyDefRecordSchema,
	relation: relationRecordSchema,
	byline_field: bylineFieldRecordSchema,
	media_folder: mediaFolderRecordSchema,
	media: mediaRecordSchema,
	term: termRecordSchema,
	byline: bylineRecordSchema,
	byline_field_value: bylineFieldValueRecordSchema,
	byline_field_group_value: bylineFieldGroupValueRecordSchema,
	revision: revisionRecordSchema,
	entry: entryRecordSchema,
	content_term: contentTermRecordSchema,
	content_byline: contentBylineRecordSchema,
	content_reference: contentReferenceRecordSchema,
	seo: seoRecordSchema,
	menu: menuRecordSchema,
	menu_item: menuItemRecordSchema,
	widget_area: widgetAreaRecordSchema,
	widget: widgetRecordSchema,
	section: sectionRecordSchema,
	redirect: redirectRecordSchema,
	comment: commentRecordSchema,
	comment_reaction: commentReactionRecordSchema,
	setting: settingRecordSchema,
} satisfies Record<RecordKind, z.ZodType<{ kind: string; id: string }>>);

export type RecordOfKind<K extends RecordKind> = z.infer<(typeof RECORD_SCHEMAS)[K]>;
export type SitePackageRecord = { [K in RecordKind]: RecordOfKind<K> }[RecordKind];

// ── Synthetic ids ───────────────────────────────────────────────

/** Kinds whose `id` is derived from other properties rather than a row id. */
export const SYNTHETIC_ID_KINDS = [
	"content_term",
	"seo",
	"byline_field_value",
	"byline_field_group_value",
] as const;

export type SyntheticIdKind = (typeof SYNTHETIC_ID_KINDS)[number];

/**
 * The deterministic id of a synthetic-id record. `setting` ids are the option
 * name and every other kind uses the origin row id.
 */
export function syntheticId(
	record:
		| Pick<ContentTermRecord, "kind" | "collection" | "entryGroup" | "termGroup">
		| Pick<SeoRecord, "kind" | "collection" | "entryId">
		| Pick<BylineFieldValueRecord, "kind" | "bylineId" | "fieldId">
		| Pick<BylineFieldGroupValueRecord, "kind" | "bylineGroup" | "fieldId">,
): string {
	switch (record.kind) {
		case "content_term":
			return `${record.collection}:${record.entryGroup}:${record.termGroup}`;
		case "seo":
			return `${record.collection}:${record.entryId}`;
		case "byline_field_value":
			return `${record.bylineId}:${record.fieldId}`;
		case "byline_field_group_value":
			return `${record.bylineGroup}:${record.fieldId}`;
	}
}

/** Id of the `content_byline` row the importer materializes for an inferred author credit. */
export function inferredCreditId(collection: string, entryId: string): string {
	return `inferred:${collection}:${entryId}`;
}

// ── References ──────────────────────────────────────────────────

/**
 * How a reference property identifies its target:
 * - `id`: the target record's `id`
 * - `group`: the target record's `translationGroup` (or its `id` when the
 *   target has no group)
 * - `slug`: a collection's `slug`
 * - `name`: a menu's `name`
 */
export type ReferenceKey = "id" | "group" | "slug" | "name";

export interface KindReference {
	property: string;
	targets: readonly RecordKind[];
	by: ReferenceKey;
	/** The property holds an array of references. */
	many?: boolean;
	/**
	 * A soft reference has no foreign key on the origin, so a dangling value is
	 * possible there. The exporter drops the owning record and declares
	 * `soft_orphan_dropped`; a package must still contain no dangling
	 * reference.
	 */
	soft?: boolean;
}

export const KIND_REFERENCES: Readonly<Record<RecordKind, readonly KindReference[]>> =
	Object.freeze({
		principal: [],
		block_type: [],
		block_type_version: [{ property: "blockTypeId", targets: ["block_type"], by: "id" }],
		collection: [],
		field: [{ property: "collectionId", targets: ["collection"], by: "id" }],
		taxonomy_def: [
			{ property: "collections", targets: ["collection"], by: "slug", many: true, soft: true },
		],
		relation: [
			{ property: "parentCollection", targets: ["collection"], by: "slug" },
			{ property: "childCollection", targets: ["collection"], by: "slug" },
		],
		byline_field: [],
		media_folder: [],
		media: [
			{ property: "authorPrincipal", targets: ["principal"], by: "id" },
			{ property: "folderId", targets: ["media_folder"], by: "id" },
		],
		term: [{ property: "parentId", targets: ["term"], by: "id" }],
		byline: [
			{ property: "avatarMediaId", targets: ["media"], by: "id" },
			{ property: "userPrincipal", targets: ["principal"], by: "id" },
		],
		byline_field_value: [
			{ property: "bylineId", targets: ["byline"], by: "id" },
			{ property: "fieldId", targets: ["byline_field"], by: "id" },
		],
		byline_field_group_value: [
			{ property: "bylineGroup", targets: ["byline"], by: "group" },
			{ property: "fieldId", targets: ["byline_field"], by: "id" },
		],
		revision: [
			{ property: "collection", targets: ["collection"], by: "slug" },
			{ property: "entryId", targets: ["entry"], by: "id" },
			{ property: "authorPrincipal", targets: ["principal"], by: "id" },
		],
		entry: [
			{ property: "collection", targets: ["collection"], by: "slug" },
			{ property: "authorPrincipal", targets: ["principal"], by: "id" },
			{ property: "primaryBylineGroup", targets: ["byline"], by: "group" },
			{ property: "liveRevisionId", targets: ["revision"], by: "id" },
			{ property: "draftRevisionId", targets: ["revision"], by: "id" },
		],
		content_term: [
			{ property: "collection", targets: ["collection"], by: "slug" },
			{ property: "entryGroup", targets: ["entry"], by: "group", soft: true },
			{ property: "termGroup", targets: ["term"], by: "group", soft: true },
		],
		content_byline: [
			{ property: "collection", targets: ["collection"], by: "slug" },
			{ property: "entryId", targets: ["entry"], by: "id" },
			{ property: "bylineGroup", targets: ["byline"], by: "group" },
		],
		content_reference: [
			{ property: "relationId", targets: ["relation"], by: "id", soft: true },
			{ property: "parentGroup", targets: ["entry"], by: "group", soft: true },
			{ property: "childGroup", targets: ["entry"], by: "group", soft: true },
		],
		seo: [
			{ property: "collection", targets: ["collection"], by: "slug" },
			{ property: "entryId", targets: ["entry"], by: "id" },
		],
		menu: [],
		menu_item: [
			{ property: "menuId", targets: ["menu"], by: "id" },
			{ property: "parentId", targets: ["menu_item"], by: "id" },
			{ property: "referenceGroup", targets: ["entry", "term"], by: "group", soft: true },
		],
		widget_area: [],
		widget: [
			{ property: "areaId", targets: ["widget_area"], by: "id" },
			{ property: "menuName", targets: ["menu"], by: "name", soft: true },
		],
		section: [{ property: "previewMediaId", targets: ["media"], by: "id" }],
		redirect: [],
		comment: [
			{ property: "collection", targets: ["collection"], by: "slug" },
			{ property: "entryId", targets: ["entry"], by: "id" },
			{ property: "parentId", targets: ["comment"], by: "id" },
			{ property: "authorPrincipal", targets: ["principal"], by: "id" },
		],
		comment_reaction: [{ property: "commentId", targets: ["comment"], by: "id" }],
		setting: [],
	});

/**
 * Block type slugs a `blocks` field refers to in `validation.allowedTypes`
 * and `validation.retiredTypes`. Each must name a `block_type` record: the
 * target resolves them whenever it reads the field.
 */
export function blocksFieldTypeSlugs(record: FieldRecord): string[] {
	const validation = record.validation;
	if (record.type !== "blocks" || typeof validation !== "object" || validation === null) return [];
	if (Array.isArray(validation)) return [];
	const slugs = new Set<string>();
	for (const list of [validation.allowedTypes, validation.retiredTypes]) {
		if (!Array.isArray(list)) continue;
		for (const slug of list) if (typeof slug === "string") slugs.add(slug);
	}
	return [...slugs];
}

/**
 * The relation slug a bound `reference` field names in `validation.relation`.
 * An unbound reference field keeps a column and names no relation.
 */
export function referenceFieldRelationSlugs(record: FieldRecord): string[] {
	const validation = record.validation;
	if (record.type !== "reference" || typeof validation !== "object" || validation === null) {
		return [];
	}
	if (Array.isArray(validation)) return [];
	const relation = validation.relation;
	return typeof relation === "string" && relation.length > 0 ? [relation] : [];
}

/**
 * Key of a block type's version: a `block_type`'s `currentVersion` must name
 * the `block_type_version` record with the same key.
 */
export function blockTypeVersionKey(blockTypeId: string, version: number): string {
	return `${blockTypeId}:${version}`;
}

/**
 * Top-level properties that carry identity rather than content. The media
 * reference walker never rewrites them.
 */
export function identityProperties(kind: RecordKind): ReadonlySet<string> {
	let properties = IDENTITY_PROPERTIES.get(kind);
	if (!properties) {
		const set = new Set<string>(["kind", "id", "translationGroup"]);
		for (const reference of KIND_REFERENCES[kind]) set.add(reference.property);
		if (kind === "media") set.add("blob");
		properties = set;
		IDENTITY_PROPERTIES.set(kind, properties);
	}
	return properties;
}

const IDENTITY_PROPERTIES = new Map<RecordKind, ReadonlySet<string>>();

// ── Import order ────────────────────────────────────────────────

export const IMPORT_RECORD_STAGES = [
	"schema",
	"media",
	"terms_bylines",
	"content",
	"relations",
	"presentation",
] as const;

export type ImportRecordStage = (typeof IMPORT_RECORD_STAGES)[number];

/**
 * Kinds written by each import stage, in write order. `principal` is never
 * written: principals only feed the plan's principal mappings.
 */
export const IMPORT_STAGE_KINDS: Readonly<Record<ImportRecordStage, readonly RecordKind[]>> =
	Object.freeze({
		schema: [
			"block_type",
			"block_type_version",
			"collection",
			"field",
			"taxonomy_def",
			"relation",
			"byline_field",
		],
		media: ["media_folder", "media"],
		terms_bylines: ["term", "byline", "byline_field_value", "byline_field_group_value"],
		content: ["revision", "entry"],
		relations: ["content_term", "content_byline", "content_reference", "seo"],
		presentation: [
			"menu",
			"menu_item",
			"widget_area",
			"widget",
			"section",
			"redirect",
			"comment",
			"comment_reaction",
			"setting",
		],
	});

export const NON_IMPORTED_KINDS: readonly RecordKind[] = Object.freeze(["principal"]);

// ── Parsing ─────────────────────────────────────────────────────

export const sitePackageRecordSchema = z.discriminatedUnion("kind", [
	principalRecordSchema,
	blockTypeRecordSchema,
	blockTypeVersionRecordSchema,
	collectionRecordSchema,
	fieldRecordSchema,
	taxonomyDefRecordSchema,
	relationRecordSchema,
	bylineFieldRecordSchema,
	mediaFolderRecordSchema,
	mediaRecordSchema,
	termRecordSchema,
	bylineRecordSchema,
	bylineFieldValueRecordSchema,
	bylineFieldGroupValueRecordSchema,
	revisionRecordSchema,
	entryRecordSchema,
	contentTermRecordSchema,
	contentBylineRecordSchema,
	contentReferenceRecordSchema,
	seoRecordSchema,
	menuRecordSchema,
	menuItemRecordSchema,
	widgetAreaRecordSchema,
	widgetRecordSchema,
	sectionRecordSchema,
	redirectRecordSchema,
	commentRecordSchema,
	commentReactionRecordSchema,
	settingRecordSchema,
]);

export interface RecordValidationIssue {
	path: string;
	message: string;
}

export type RecordValidationResult<K extends RecordKind> =
	| { success: true; record: RecordOfKind<K> }
	| { success: false; issues: RecordValidationIssue[] };

/**
 * Validate a parsed record against the strict schema for `kind`, including
 * the synthetic-id rule for synthetic-id kinds. Issues carry fixed messages
 * and at most a top-level property name, never package content.
 */
export function validateRecord<K extends RecordKind>(
	kind: K,
	value: unknown,
): RecordValidationResult<K> {
	const declaredKind: unknown =
		typeof value === "object" && value !== null ? Reflect.get(value, "kind") : undefined;
	if (declaredKind !== kind) {
		return { success: false, issues: [{ path: "kind", message: `Expected kind ${kind}` }] };
	}
	const result = sitePackageRecordSchema.safeParse(value);
	if (!result.success) {
		return {
			success: false,
			issues: result.error.issues
				.slice(0, 20)
				.map((issue) => summarizeSchemaIssue(issue, RECORD_SCHEMAS[kind].shape)),
		};
	}
	const record = result.data;
	const expected = expectedSyntheticId(record);
	if (expected !== null && record.id !== expected) {
		return {
			success: false,
			issues: [{ path: "id", message: "Synthetic id does not match its components" }],
		};
	}
	if (!isRecordOfKind(record, kind)) {
		return { success: false, issues: [{ path: "kind", message: `Expected kind ${kind}` }] };
	}
	return { success: true, record };
}

export function isRecordOfKind<K extends RecordKind>(
	record: SitePackageRecord,
	kind: K,
): record is RecordOfKind<K> {
	return record.kind === kind;
}

function expectedSyntheticId(record: SitePackageRecord): string | null {
	switch (record.kind) {
		case "content_term":
		case "seo":
		case "byline_field_value":
		case "byline_field_group_value":
			return syntheticId(record);
		default:
			return null;
	}
}
