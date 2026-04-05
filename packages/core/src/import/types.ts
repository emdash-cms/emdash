/**
 * Import source abstraction
 *
 * Allows different import sources (WXR file, WordPress.com API, REST API, plugin)
 * to all produce the same normalized format for the import flow.
 */

import type { PortableTextBlock } from "@emdash-cms/gutenberg-to-portable-text";

// =============================================================================
// Author Types
// =============================================================================

/** Author info from an external import source */
export interface ImportAuthorInfo {
	id?: number | string;
	login?: string;
	email?: string;
	displayName?: string;
	postCount: number;
}

// =============================================================================
// Source Input Types
// =============================================================================

/** File-based input (WXR upload) */
export interface FileInput {
	type: "file";
	file: File;
}

/** URL-based input (REST API probe) */
export interface UrlInput {
	type: "url";
	url: string;
	/** Optional auth token for authenticated requests */
	token?: string;
}

/** OAuth-based input (WordPress.com) */
export interface OAuthInput {
	type: "oauth";
	url: string;
	accessToken: string;
	/** Site ID for WordPress.com */
	siteId?: string;
}

export type SourceInput = FileInput | UrlInput | OAuthInput;

// =============================================================================
// Probe Result Types
// =============================================================================

/** Auth requirements for an import source */
export interface SourceAuth {
	type: "oauth" | "token" | "password" | "none";
	/** OAuth provider identifier */
	provider?: string;
	/** OAuth authorization URL */
	oauthUrl?: string;
	/** Human-readable instructions */
	instructions?: string;
}

/** What the source can provide */
export interface SourceCapabilities {
	/** Can fetch published content without auth */
	publicContent: boolean;
	/** Can fetch drafts/private (may need auth) */
	privateContent: boolean;
	/** Can fetch all custom post types */
	customPostTypes: boolean;
	/** Can fetch all meta fields */
	allMeta: boolean;
	/** Can stream media directly */
	mediaStream: boolean;
}

/** Suggested next action after probe */
export type SuggestedAction =
	| { type: "proceed" }
	| { type: "oauth"; url: string; provider: string }
	| { type: "upload"; instructions: string }
	| { type: "install-plugin"; instructions: string };

/** Detected i18n/multilingual plugin info */
export interface I18nDetection {
	/** Multilingual plugin name (e.g. "wpml", "polylang") */
	plugin: string;
	/** BCP 47 default locale */
	defaultLocale: string;
	/** All configured locales */
	locales: string[];
}

/** Result of probing a URL for a specific source */
export interface SourceProbeResult {
	/** Which source can handle this */
	sourceId: string;

	/** Confidence level */
	confidence: "definite" | "likely" | "possible";

	/** What we detected */
	detected: {
		platform: string;
		version?: string;
		siteTitle?: string;
		siteUrl?: string;
	};

	/** What capabilities are available */
	capabilities: SourceCapabilities;

	/** What auth is needed, if any */
	auth?: SourceAuth;

	/** Suggested next step */
	suggestedAction: SuggestedAction;

	/** Preview data if available (e.g., post counts from REST API) */
	preview?: {
		posts?: number;
		pages?: number;
		media?: number;
	};

	/** Detected multilingual plugin. Absent when none detected. */
	i18n?: I18nDetection;
}

/** Combined probe result from all sources */
export interface ProbeResult {
	url: string;
	isWordPress: boolean;
	/** Best matching source (highest confidence) */
	bestMatch: SourceProbeResult | null;
	/** All matching sources */
	allMatches: SourceProbeResult[];
}

// =============================================================================
// Analysis Types (normalized from all sources)
// =============================================================================

/** Field definition for import */
export interface ImportFieldDef {
	slug: string;
	label: string;
	type: string;
	required: boolean;
	searchable?: boolean;
}

/** Field compatibility with existing schema */
export type FieldCompatibility = "compatible" | "type_mismatch" | "missing";

/** Schema status for a collection */
export interface CollectionSchemaStatus {
	exists: boolean;
	fieldStatus: Record<
		string,
		{
			status: FieldCompatibility;
			existingType?: string;
			requiredType: string;
		}
	>;
	canImport: boolean;
	reason?: string;
}

/** Analysis of a single post type */
export interface PostTypeAnalysis {
	name: string;
	count: number;
	suggestedCollection: string;
	requiredFields: ImportFieldDef[];
	schemaStatus: CollectionSchemaStatus;
}

/** Attachment/media info */
export interface AttachmentInfo {
	id?: number | string;
	title?: string;
	url?: string;
	filename?: string;
	mimeType?: string;
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
}

/** Navigation menu analysis */
export interface NavMenuAnalysis {
	/** Menu name/slug */
	name: string;
	/** Menu display label */
	label: string;
	/** Number of items in this menu */
	itemCount: number;
}

/** Custom taxonomy analysis */
export interface TaxonomyAnalysis {
	/** Taxonomy slug (e.g., 'genre', 'portfolio_category') */
	slug: string;
	/** Number of terms in this taxonomy */
	termCount: number;
	/** Sample term names */
	sampleTerms: string[];
}

/** Reusable block analysis (wp_block post type) */
export interface ReusableBlockAnalysis {
	/** Original WP ID */
	id: number;
	/** Block title */
	title: string;
	/** Block slug */
	slug: string;
}

/** Normalized analysis result - same format for all sources */
export interface ImportAnalysis {
	/** Source that produced this analysis */
	sourceId: string;

	site: {
		title: string;
		url: string;
	};

	postTypes: PostTypeAnalysis[];

	attachments: {
		count: number;
		items: AttachmentInfo[];
	};

	categories: number;
	tags: number;
	authors: ImportAuthorInfo[];

	/** Navigation menus found in the export */
	navMenus?: NavMenuAnalysis[];

	/** Custom taxonomies (beyond categories/tags) */
	customTaxonomies?: TaxonomyAnalysis[];

	/** Reusable blocks (wp_block post type) - will be imported as sections */
	reusableBlocks?: ReusableBlockAnalysis[];

	/** Source-specific custom fields analysis */
	customFields?: Array<{
		key: string;
		count: number;
		samples: string[];
		suggestedField: string;
		suggestedType: "string" | "number" | "boolean" | "date" | "json";
		isInternal: boolean;
	}>;

	/** Detected multilingual plugin. Absent when none detected. */
	i18n?: I18nDetection;
}

// =============================================================================
// Normalized Content Types
// =============================================================================

/** Normalized content item - produced by all sources */
export interface NormalizedItem {
	/** Original ID from source */
	sourceId: string | number;
	/** WordPress post type */
	postType: string;
	/** Content status */
	status: "publish" | "draft" | "pending" | "private" | "future";
	/** URL slug */
	slug: string;
	/** Title */
	title: string;
	/** Content as Portable Text (already converted) */
	content: PortableTextBlock[];
	/** Excerpt/summary */
	excerpt?: string;
	/** Sanitized HTML body for sources that are HTML-first */
	html?: string;
	/** Original public path in the source system */
	sourcePath?: string;
	/** Source visibility hint (e.g. public, members, paid) */
	visibility?: string;
	/** Publication date */
	date: Date;
	/** Last modified date */
	modified?: Date;
	/** Author identifier */
	author?: string;
	/** Category slugs */
	categories?: string[];
	/** Tag slugs */
	tags?: string[];
	/** Custom meta fields */
	meta?: Record<string, unknown>;
	/** Featured image URL */
	featuredImage?: string;
	/** Parent post ID (for hierarchical content like pages) */
	parentId?: string | number;
	/** Menu order for sorting */
	menuOrder?: number;
	/** Custom taxonomy assignments beyond categories/tags */
	customTaxonomies?: Record<string, string[]>;

	/** BCP 47 locale code. When omitted, defaults to defaultLocale. */
	locale?: string;

	/**
	 * Source-side translation group ID (opaque string from the origin system).
	 * Items sharing the same translationGroup are linked as translations.
	 * Resolved to an EmDash translation_group ULID during execute.
	 */
	translationGroup?: string;
}

// =============================================================================
// Import Configuration & Results
// =============================================================================

/** Post type mapping configuration */
export interface PostTypeMapping {
	enabled: boolean;
	collection: string;
}

/** Import configuration */
export interface ImportConfig {
	postTypeMappings: Record<string, PostTypeMapping>;
	skipExisting?: boolean;
}

/** Options for fetching content */
export interface FetchOptions {
	/** Post types to fetch */
	postTypes: string[];
	/** Whether to include drafts */
	includeDrafts?: boolean;
	/** Limit number of items (for testing) */
	limit?: number;
}

/** Import result */
export interface ImportResult {
	success: boolean;
	imported: number;
	skipped: number;
	errors: Array<{ title: string; error: string }>;
	byCollection: Record<string, number>;
}

// =============================================================================
// Import Source Interface
// =============================================================================

/**
 * An import source provides content from an external system.
 * All sources produce the same normalized analysis and content format.
 */
export interface ImportSource {
	/** Unique identifier */
	id: string;

	/** Display name */
	name: string;

	/** Description for UI */
	description: string;

	/** Icon identifier */
	icon: "upload" | "globe" | "wordpress" | "plug";

	/** Whether this source requires a file upload */
	requiresFile?: boolean;

	/** Whether this source can probe URLs */
	canProbe?: boolean;

	/**
	 * Probe a URL to see if this source can handle it.
	 * Returns null if not applicable.
	 */
	probe?(url: string): Promise<SourceProbeResult | null>;

	/**
	 * Analyze content from this source.
	 * Returns normalized ImportAnalysis.
	 */
	analyze(input: SourceInput, context: ImportContext): Promise<ImportAnalysis>;

	/**
	 * Stream content items for import.
	 * Yields normalized content items.
	 */
	fetchContent(input: SourceInput, options: FetchOptions): AsyncGenerator<NormalizedItem>;

	/**
	 * Fetch a media item's data.
	 * Used for media import.
	 */
	fetchMedia?(url: string, input: SourceInput): Promise<Blob>;
}

/** Context passed to import sources */
export interface ImportContext {
	/** Database connection for schema checks */
	db?: unknown;
	/** Function to check existing collections */
	getExistingCollections?: () => Promise<
		Map<string, { slug: string; fields: Map<string, { type: string }> }>
	>;
}
