/**
 * Media Provider Types
 *
 * Media providers are pluggable sources for browsing, uploading, and embedding media.
 * They enable integration with external services (Unsplash, Cloudinary, Mux, etc.)
 * alongside the built-in local media library.
 */

/**
 * Serializable media provider configuration descriptor
 * Returned by provider config functions (e.g., unsplash(), mux())
 */
export interface MediaProviderDescriptor<TConfig = Record<string, unknown>> {
	/** Unique identifier, used in MediaValue.provider */
	id: string;

	/** Display name for admin UI */
	name: string;

	/** Icon for tab UI (emoji or URL) */
	icon?: string;

	/** Module path exporting createMediaProvider function */
	entrypoint: string;

	/** Optional React component module for custom admin UI */
	adminModule?: string;

	/** Capability flags determine UI behavior */
	capabilities: MediaProviderCapabilities;

	/** Serializable config passed to createMediaProvider at runtime */
	config: TConfig;
}

/**
 * Provider capabilities determine what UI elements to show
 */
export interface MediaProviderCapabilities {
	/** Can list/browse media */
	browse: boolean;
	/** Supports text search */
	search: boolean;
	/** Can upload new media */
	upload: boolean;
	/** Can delete media */
	delete: boolean;
}

/**
 * Options for listing media
 */
export interface MediaListOptions {
	/** Pagination cursor */
	cursor?: string;
	/** Max items to return (default 20) */
	limit?: number;
	/** Search query (if capabilities.search is true) */
	query?: string;
	/** Filter by MIME type prefix, e.g., "image/", "video/" */
	mimeType?: string;
}

/**
 * Result from listing media
 */
export interface MediaListResult {
	items: MediaProviderItem[];
	nextCursor?: string;
}

/**
 * A media item as returned by a provider
 * This is the provider's view of the item, before it's selected
 */
export interface MediaProviderItem {
	/** Provider-specific ID */
	id: string;
	/** Original filename */
	filename: string;
	/** MIME type */
	mimeType: string;
	/** File size in bytes (if known) */
	size?: number;
	/** Dimensions (for images/video) */
	width?: number;
	height?: number;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
	/** Accessibility text */
	alt?: string;
	/** Preview URL for admin UI thumbnail */
	previewUrl?: string;
	/** Provider-specific metadata */
	meta?: Record<string, unknown>;
}

/**
 * Input for uploading media
 */
export interface MediaUploadInput {
	file: File;
	filename: string;
	alt?: string;
}

/**
 * Options for generating embed
 */
export interface EmbedOptions {
	/** Desired width (provider may use for optimization) */
	width?: number;
	/** Desired height */
	height?: number;
	/** Image format preference */
	format?: "webp" | "avif" | "jpeg" | "png" | "auto";
}

/**
 * Embed result types
 */
export type EmbedResult = ImageEmbed | VideoEmbed | AudioEmbed | ComponentEmbed;

export interface ImageEmbed {
	type: "image";
	src: string;
	srcset?: string;
	sizes?: string;
	width?: number;
	height?: number;
	/** LQIP blurhash placeholder for rendering before the image loads */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color */
	dominantColor?: string;
	alt?: string;
	/** Base URL without transforms, for responsive image generation */
	cdnBaseUrl?: string;
	/** For providers with URL-based transforms (Cloudinary, imgix) */
	getSrc?: (opts: { width?: number; height?: number; format?: string }) => string;
}

export interface VideoEmbed {
	type: "video";
	/** Single source URL */
	src?: string;
	/** Multiple sources for format fallback */
	sources?: Array<{ src: string; type: string }>;
	/** Poster/thumbnail image */
	poster?: string;
	width?: number;
	height?: number;
	/** Player controls */
	controls?: boolean;
	autoplay?: boolean;
	muted?: boolean;
	loop?: boolean;
	playsinline?: boolean;
	preload?: "none" | "metadata" | "auto";
	crossorigin?: "anonymous" | "use-credentials";
}

export interface AudioEmbed {
	type: "audio";
	src?: string;
	sources?: Array<{ src: string; type: string }>;
	controls?: boolean;
	autoplay?: boolean;
	muted?: boolean;
	loop?: boolean;
	preload?: "none" | "metadata" | "auto";
}

export interface ComponentEmbed {
	type: "component";
	/** Package to import from, e.g., "@mux/player-react" */
	package: string;
	/** Named export (default export if not specified) */
	export?: string;
	/** Props to pass to the component */
	props: Record<string, unknown>;
}

/**
 * Options for thumbnail generation
 */
export interface ThumbnailOptions {
	/** Desired width */
	width?: number;
	/** Desired height */
	height?: number;
}

/**
 * Runtime media provider interface
 * Implemented by provider entrypoints
 */
export interface MediaProvider {
	/**
	 * List/search media items
	 */
	list(options: MediaListOptions): Promise<MediaListResult>;

	/**
	 * Get a single item by ID (optional, for refresh/validation)
	 */
	get?(id: string): Promise<MediaProviderItem | null>;

	/**
	 * Upload new media (if capabilities.upload is true)
	 */
	upload?(input: MediaUploadInput): Promise<MediaProviderItem>;

	/**
	 * Delete media (if capabilities.delete is true)
	 */
	delete?(id: string): Promise<void>;

	/**
	 * Get embed information for rendering this media item
	 * Called at runtime when rendering content
	 */
	getEmbed(value: MediaValue, options?: EmbedOptions): Promise<EmbedResult> | EmbedResult;

	/**
	 * Get a thumbnail URL for admin display
	 * For images: returns a resized image URL
	 * For videos: returns a poster/thumbnail URL
	 */
	getThumbnailUrl?(id: string, mimeType?: string, options?: ThumbnailOptions): string;
}

/**
 * Function signature for provider entrypoint modules
 */
export type CreateMediaProviderFn<TConfig = Record<string, unknown>> = (
	config: TConfig,
) => MediaProvider;

/**
 * Media value stored in content fields
 * This is what gets persisted when media is selected
 *
 * For backwards compatibility:
 * - `provider` defaults to "local" if not specified
 * - `src` is supported for legacy data or external URLs
 */
export interface MediaValue {
	/** Provider ID, e.g., "local", "unsplash", "mux" (defaults to "local") */
	provider?: string;

	/** Provider-specific item ID */
	id: string;

	/** Direct URL (for local media or legacy data) */
	src?: string;

	/** Preview URL for admin display (external providers) */
	previewUrl?: string;

	/** Cached metadata for display without runtime lookup */
	filename?: string;
	mimeType?: string;
	width?: number;
	height?: number;
	/** Cached LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** Cached LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
	alt?: string;

	/** Provider-specific data needed for embedding */
	meta?: Record<string, unknown>;
}

/**
 * Convert a MediaProviderItem to a MediaValue for storage
 */
export function mediaItemToValue(providerId: string, item: MediaProviderItem): MediaValue {
	return {
		provider: providerId,
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		width: item.width,
		height: item.height,
		blurhash: item.blurhash,
		dominantColor: item.dominantColor,
		alt: item.alt,
		meta: item.meta,
	};
}
