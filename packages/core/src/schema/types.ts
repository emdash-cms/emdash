/**
 * Schema Registry Types
 *
 * These types represent the schema definitions stored in D1.
 * They are the source of truth for all collections and fields.
 */

/**
 * Supported field types
 */
export type FieldType =
	| "string"
	| "text"
	| "url"
	| "number"
	| "integer"
	| "boolean"
	| "date"
	| "datetime"
	| "select"
	| "multiSelect"
	| "portableText"
	| "image"
	| "file"
	| "reference"
	| "json"
	| "slug"
	| "repeater";

/**
 * Array of all field types for validation
 */
export const FIELD_TYPES: readonly FieldType[] = [
	"string",
	"text",
	"url",
	"number",
	"integer",
	"boolean",
	"date",
	"datetime",
	"select",
	"multiSelect",
	"portableText",
	"image",
	"file",
	"reference",
	"json",
	"slug",
	"repeater",
] as const;

/**
 * SQLite column types that map from field types
 */
export type ColumnType = "TEXT" | "REAL" | "INTEGER" | "JSON";

/**
 * Map field types to their SQLite column types
 */
export const FIELD_TYPE_TO_COLUMN: Record<FieldType, ColumnType> = {
	string: "TEXT",
	text: "TEXT",
	number: "REAL",
	integer: "INTEGER",
	boolean: "INTEGER",
	date: "TEXT",
	datetime: "TEXT",
	select: "TEXT",
	multiSelect: "JSON",
	portableText: "JSON",
	image: "TEXT",
	file: "TEXT",
	reference: "TEXT",
	json: "JSON",
	slug: "TEXT",
	url: "TEXT",
	repeater: "JSON",
};

/**
 * Features a collection can support
 */
export type CollectionSupport =
	| "drafts"
	| "revisions"
	| "preview"
	| "scheduling"
	| "search"
	| "seo";

/**
 * Sources for how a collection was created
 */
export type CollectionSource =
	| `template:${string}`
	| `import:${string}`
	| "manual"
	| "discovered"
	| "seed";

/**
 * Validation rules for a field
 */
/** Sub-field definition for repeater fields */
export interface RepeaterSubField {
	slug: string;
	type:
		| "string"
		| "text"
		| "url"
		| "number"
		| "integer"
		| "boolean"
		| "date"
		| "datetime"
		| "select"
		| "image";
	label: string;
	required?: boolean;
	options?: string[]; // For select sub-fields
}

/** Allowed types for repeater sub-fields (no nesting, no complex types) */
export const REPEATER_SUB_FIELD_TYPES = [
	"string",
	"text",
	"url",
	"number",
	"integer",
	"boolean",
	"date",
	"datetime",
	"select",
	"image",
] as const;

export interface FieldValidation {
	required?: boolean;
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	options?: string[]; // For select/multiSelect
	subFields?: RepeaterSubField[]; // For repeater fields
	minItems?: number; // For repeater fields
	maxItems?: number; // For repeater fields
	allowedMimeTypes?: string[];
}

/**
 * Widget options for field rendering
 */
export interface FieldWidgetOptions {
	rows?: number; // For textarea
	showPreview?: boolean; // For image/file
	collection?: string; // For reference - which collection to reference
	allowMultiple?: boolean; // For reference
	[key: string]: unknown;
}

/**
 * A collection definition
 */
export interface Collection {
	id: string;
	slug: string;
	label: string;
	labelSingular?: string;
	description?: string;
	icon?: string;
	supports: CollectionSupport[];
	source?: CollectionSource;
	/** Whether this collection has SEO metadata fields enabled */
	hasSeo: boolean;
	/** URL pattern with {slug} placeholder (e.g. "/{slug}", "/blog/{slug}") */
	urlPattern?: string;
	/** Whether comments are enabled for this collection */
	commentsEnabled: boolean;
	/** Moderation strategy: "all" | "first_time" | "none" */
	commentsModeration: "all" | "first_time" | "none";
	/** Auto-close comments after N days. 0 = never close. */
	commentsClosedAfterDays: number;
	/** Auto-approve comments from authenticated CMS users */
	commentsAutoApproveUsers: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * A field definition
 */
export interface Field {
	id: string;
	collectionId: string;
	slug: string;
	label: string;
	type: FieldType;
	columnType: ColumnType;
	required: boolean;
	unique: boolean;
	defaultValue?: unknown;
	validation?: FieldValidation;
	widget?: string;
	options?: FieldWidgetOptions;
	sortOrder: number;
	searchable: boolean;
	/** Whether this field is translatable (default true). Non-translatable fields are synced across locales. */
	translatable: boolean;
	createdAt: string;
}

/**
 * Input for creating a collection
 */
export interface CreateCollectionInput {
	slug: string;
	label: string;
	labelSingular?: string;
	description?: string;
	icon?: string;
	supports?: CollectionSupport[];
	source?: CollectionSource;
	urlPattern?: string;
	hasSeo?: boolean;
	commentsEnabled?: boolean;
}

/**
 * Input for updating a collection
 */
export interface UpdateCollectionInput {
	label?: string;
	labelSingular?: string;
	description?: string;
	icon?: string;
	supports?: CollectionSupport[];
	urlPattern?: string;
	hasSeo?: boolean;
	commentsEnabled?: boolean;
	commentsModeration?: "all" | "first_time" | "none";
	commentsClosedAfterDays?: number;
	commentsAutoApproveUsers?: boolean;
}

/**
 * Input for creating a field
 */
export interface CreateFieldInput {
	slug: string;
	label: string;
	type: FieldType;
	required?: boolean;
	unique?: boolean;
	defaultValue?: unknown;
	validation?: FieldValidation | null;
	widget?: string;
	options?: FieldWidgetOptions;
	sortOrder?: number;
	/** Whether this field should be indexed for search */
	searchable?: boolean;
	/** Whether this field is translatable (default true). Non-translatable fields are synced across locales. */
	translatable?: boolean;
}

/**
 * Input for updating a field
 */
export interface UpdateFieldInput {
	label?: string;
	required?: boolean;
	unique?: boolean;
	defaultValue?: unknown;
	validation?: FieldValidation | null;
	widget?: string;
	options?: FieldWidgetOptions;
	sortOrder?: number;
	/** Whether this field should be indexed for search */
	searchable?: boolean;
	/** Whether this field is translatable (default true). Non-translatable fields are synced across locales. */
	translatable?: boolean;
}

/**
 * A collection with its fields
 */
export interface CollectionWithFields extends Collection {
	fields: Field[];
}

/**
 * Reserved field slugs that cannot be used.
 *
 * Includes names reserved for runtime hydration (`terms`, `bylines`, `byline`)
 * so user-defined fields never shadow the auto-hydrated values on entry.data.
 */
export const RESERVED_FIELD_SLUGS = [
	"id",
	"slug",
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	// Runtime-hydrated fields
	"terms",
	"bylines",
	"byline",
];

/**
 * Reserved collection slugs that cannot be used
 */
export const RESERVED_COLLECTION_SLUGS = [
	"content",
	"media",
	"users",
	"revisions",
	"taxonomies",
	"options",
	"audit_logs",
];

/**
 * Byline custom fields (Discussion #1174).
 *
 * Sites declare site-specific byline metadata (`job_title`, `pronouns`,
 * `twitter_handle`, `company`, …) without touching emdash core. Definitions
 * live in `_emdash_byline_fields`; values in either
 * `_emdash_byline_field_values` (translatable, keyed by `byline_id`) or
 * `_emdash_byline_field_group_values` (non-translatable, keyed by
 * `translation_group`). The per-field `translatable` flag decides which
 * value table is used. See migration 041.
 */

/**
 * The five v1 field types supported on byline custom fields. Deliberately
 * narrower than the content `FieldType` union — bylines don't need
 * `portableText`, `reference`, `image`, etc. v2 may extend this; v1 keeps
 * the storage and UI surfaces small.
 */
export type BylineFieldType = "string" | "text" | "url" | "boolean" | "select";

export const BYLINE_FIELD_TYPES: readonly BylineFieldType[] = [
	"string",
	"text",
	"url",
	"boolean",
	"select",
] as const;

/**
 * Validation rules for a byline custom field. v1 only exposes `options`
 * (the choice list for `select` fields). The shape mirrors the content-
 * field convention so the admin UI patterns transfer.
 */
export interface BylineFieldValidation {
	/** Choices for `select`-type fields. Ignored for other types. */
	options?: string[];
}

/**
 * Runtime shape of a registered byline custom field. Stored in
 * `_emdash_byline_fields` (see migration 041).
 */
export interface BylineFieldDefinition {
	id: string;
	slug: string;
	label: string;
	type: BylineFieldType;
	required: boolean;
	/**
	 * Whether values are stored per-locale (`true`, in
	 * `_emdash_byline_field_values` keyed by `byline_id`) or shared across
	 * every locale variant of the same byline identity (`false`, in
	 * `_emdash_byline_field_group_values` keyed by `translation_group`).
	 * Defaults to `true` at the DB level.
	 */
	translatable: boolean;
	validation: BylineFieldValidation | null;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

/**
 * Input for creating a byline custom field. `slug` and `type` are not
 * updatable post-create — changing either would invalidate stored values.
 */
export interface CreateBylineFieldInput {
	slug: string;
	label: string;
	type: BylineFieldType;
	required?: boolean;
	translatable?: boolean;
	validation?: BylineFieldValidation | null;
	sortOrder?: number;
}

/**
 * Input for updating a byline custom field. `slug` and `type` are
 * intentionally not present — see `CreateBylineFieldInput`.
 */
export interface UpdateBylineFieldInput {
	label?: string;
	required?: boolean;
	translatable?: boolean;
	validation?: BylineFieldValidation | null;
	sortOrder?: number;
}

/**
 * Runtime value type for a byline custom field. The narrow union mirrors
 * what the five v1 field types can produce: `string`/`text`/`url`/`select`
 * → string, `boolean` → boolean, plus `null` for cleared values.
 */
export type CustomFieldValue = string | boolean | null;

/**
 * Reserved byline-field slugs. Two reasons a slug ends up here:
 *
 * 1. **Column collision.** Slugs that match a fixed column on
 *    `_emdash_bylines` (migrations 031 + 040) would shadow that column
 *    on hydration. The first 12 entries cover this.
 * 2. **Route collision.** Static file routes under
 *    `/_emdash/api/admin/byline-fields/` take precedence over the
 *    `[slug].ts` dynamic route in Astro, so a custom field whose slug
 *    matches a sibling static file (e.g. `reorder.ts`) is unreachable
 *    via single-field CRUD — the static route handles only its own
 *    method (POST for `reorder`) and 405s everything else.
 *    `reorder` is the only such sibling today; new sibling routes
 *    (e.g. a hypothetical `import.ts`) must be added here.
 *    `[slug]/usage.ts` lives a level deeper so a slug of `usage` does
 *    not collide — it resolves cleanly to `[slug].ts`.
 *
 * Enforced at the registry layer (Phase 2) and the admin API zod layer
 * (Phase 4) so non-HTTP callers (seeds, scripts) get the same guarantee.
 */
export const RESERVED_BYLINE_FIELD_SLUGS = [
	// 1. Column-collision slugs (matches `_emdash_bylines` fixed columns).
	"id",
	"slug",
	"display_name",
	"bio",
	"avatar_media_id",
	"website_url",
	"user_id",
	"is_guest",
	"locale",
	"translation_group",
	"created_at",
	"updated_at",
	// 2. Route-collision slugs (matches static sibling files of `[slug].ts`).
	"reorder",
] as const;
