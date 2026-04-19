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
	type: "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select";
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
	"datetime",
	"select",
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
	validation?: FieldValidation;
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
	validation?: FieldValidation;
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
