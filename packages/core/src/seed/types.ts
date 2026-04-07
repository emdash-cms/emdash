/**
 * Seed file types for bootstrapping EmDash sites
 *
 * Seed files are DB-agnostic JSON documents that declare everything needed to set up a site:
 * collections, fields, menus, settings, taxonomies, redirects, widget areas, and optional sample content.
 */

import type { FieldType } from "../schema/types.js";
import type { SiteSettings } from "../settings/types.js";
import type { Storage } from "../storage/types.js";

/**
 * Root seed file structure
 */
export interface SeedFile {
	/** JSON schema reference (optional) */
	$schema?: string;

	/** Seed format version */
	version: "1";

	/** Metadata about the seed */
	meta?: {
		name?: string;
		description?: string;
		author?: string;
	};

	/** Site settings */
	settings?: Partial<SiteSettings>;

	/** Collection definitions */
	collections?: SeedCollection[];

	/** Taxonomy definitions */
	taxonomies?: SeedTaxonomy[];

	/** Navigation menus */
	menus?: SeedMenu[];

	/** Redirect rules */
	redirects?: SeedRedirect[];

	/** Widget areas */
	widgetAreas?: SeedWidgetArea[];

	/** Sections (reusable content blocks, like WP patterns/reusable blocks) */
	sections?: SeedSection[];

	/** Bylines used for presentation credits */
	bylines?: SeedByline[];

	/** Sample content (organized by collection) */
	content?: Record<string, SeedContentEntry[]>;
}

/**
 * Collection definition in seed
 */
export interface SeedCollection {
	slug: string;
	label: string;
	labelSingular?: string;
	description?: string;
	icon?: string;
	/** Admin UI group name (e.g., "Trading", "LMS", "Community") */
	group?: string;
	/** Sort order within group (lower = earlier) */
	sortOrder?: number;
	supports?: ("drafts" | "revisions" | "preview" | "scheduling" | "search" | "seo")[];
	urlPattern?: string;
	/** Enable comments on this collection */
	commentsEnabled?: boolean;
	fields: SeedField[];
}

/**
 * Field definition in seed
 */
export interface SeedField {
	slug: string;
	label: string;
	type: FieldType;
	required?: boolean;
	unique?: boolean;
	searchable?: boolean;
	defaultValue?: unknown;
	validation?: Record<string, unknown>;
	widget?: string;
	options?: Record<string, unknown>;
}

/**
 * Taxonomy definition in seed
 */
export interface SeedTaxonomy {
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	collections: string[];
	terms?: SeedTaxonomyTerm[];
}

/**
 * Taxonomy term in seed
 */
export interface SeedTaxonomyTerm {
	slug: string;
	label: string;
	description?: string;
	parent?: string; // Slug of parent term (for hierarchical taxonomies)
}

/**
 * Menu definition in seed
 */
export interface SeedMenu {
	name: string;
	label: string;
	items: SeedMenuItem[];
}

/**
 * Menu item in seed
 */
export interface SeedMenuItem {
	type: string;
	label?: string;
	url?: string; // For custom type
	ref?: string; // For page/post: content id in seed; for taxonomy: term slug
	collection?: string; // Collection name for page/post/taxonomy types
	target?: "_blank" | "_self";
	titleAttr?: string;
	cssClasses?: string;
	children?: SeedMenuItem[];
}

/**
 * Redirect definition in seed
 */
export interface SeedRedirect {
	source: string;
	destination: string;
	type?: 301 | 302 | 307 | 308;
	enabled?: boolean;
	groupName?: string | null;
}

/**
 * Widget area definition in seed
 */
export interface SeedWidgetArea {
	name: string;
	label: string;
	description?: string;
	widgets: SeedWidget[];
}

/**
 * Widget in seed
 */
export interface SeedWidget {
	type: "content" | "menu" | "component";
	title?: string;

	// For content widgets - using loose type since @portabletext/types is optional
	content?: Array<{ _type: string; _key?: string; [key: string]: unknown }>;

	// For menu widgets
	menuName?: string;

	// For component widgets
	componentId?: string;
	props?: Record<string, unknown>;
}

/**
 * Section (reusable content block) in seed
 */
export interface SeedSection {
	slug: string;
	title: string;
	description?: string;
	/** Search keywords */
	keywords?: string[];
	/** Portable Text content */
	content: Array<{ _type: string; _key?: string; [key: string]: unknown }>;
	/** Source: "theme" for seed-provided, "import" for WP imports */
	source?: "theme" | "import";
}

/**
 * Byline profile in seed
 */
export interface SeedByline {
	/** Seed-local ID for byline references in content entries */
	id: string;
	slug: string;
	displayName: string;
	bio?: string;
	websiteUrl?: string;
	isGuest?: boolean;
}

/**
 * Content entry in seed
 */
export interface SeedContentEntry {
	/** Seed-local ID for $ref resolution */
	id: string;

	/** URL slug */
	slug: string;

	/** Publication status */
	status?: "published" | "draft";

	/** Content data (field slug -> value) */
	data: Record<string, unknown>;

	/** Taxonomy term assignments (taxonomy name -> term slugs) */
	taxonomies?: Record<string, string[]>;

	/** Ordered byline credits for this entry */
	bylines?: SeedBylineCredit[];

	/** BCP 47 locale code. When omitted, defaults to defaultLocale. */
	locale?: string;

	/**
	 * Seed-local ID of the source content entry this translates.
	 * Must reference another entry's `id` in the same collection.
	 */
	translationOf?: string;
}

export interface SeedBylineCredit {
	/** Seed byline ID from root `bylines[]` */
	byline: string;
	roleLabel?: string;
}

/**
 * Options for applying a seed
 */
export interface SeedApplyOptions {
	/** Include sample content (default: false) */
	includeContent?: boolean;

	/** How to handle conflicts (default: "skip") */
	onConflict?: "skip" | "update" | "error";

	/** Base path for local media files (for $media.file resolution) */
	mediaBasePath?: string;

	/**
	 * Storage adapter for media uploads.
	 * Required if seed contains $media references with URLs.
	 */
	storage?: Storage;

	/**
	 * Skip downloading and storing media for $media references.
	 *
	 * When true, $media references are resolved to a MediaValue
	 * that uses the original external URL directly as the `src`,
	 * with provider set to "external". No storage adapter is needed.
	 *
	 * Useful for playground/demo environments where media storage
	 * is unavailable or undesirable.
	 */
	skipMediaDownload?: boolean;
}

/**
 * Result of applying a seed
 */
export interface SeedApplyResult {
	collections: { created: number; skipped: number; updated: number };
	fields: { created: number; skipped: number; updated: number };
	taxonomies: { created: number; terms: number };
	bylines: { created: number; skipped: number; updated: number };
	menus: { created: number; items: number };
	redirects: { created: number; skipped: number; updated: number };
	widgetAreas: { created: number; widgets: number };
	sections: { created: number; skipped: number; updated: number };
	settings: { applied: number };
	content: { created: number; skipped: number; updated: number };
	media: { created: number; skipped: number };
}

/**
 * Validation result
 */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Media queue item for background download
 */
export interface MediaQueueItem {
	url: string;
	targetMediaId: string;
	alt?: string;
	filename?: string;
}

/**
 * $media reference in seed content
 *
 * Use this syntax in seed files to import media from URLs:
 * ```json
 * {
 *   "featured_image": {
 *     "$media": {
 *       "url": "https://images.unsplash.com/photo-xxx",
 *       "alt": "Description of the image",
 *       "filename": "my-image.jpg"
 *     }
 *   }
 * }
 * ```
 *
 * The seed engine will:
 * 1. Download the image from the URL
 * 2. Upload it to the configured storage
 * 3. Create a media record in the database
 * 4. Replace the $media object with the proper field value
 */
export interface SeedMediaReference {
	$media: {
		/** URL to download the media from */
		url: string;
		/** Alt text for the image */
		alt?: string;
		/** Custom filename (defaults to URL basename or generated) */
		filename?: string;
		/** Caption for the media */
		caption?: string;
	};
}
