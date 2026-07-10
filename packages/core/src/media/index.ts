/**
 * Media Provider Exports
 *
 * Public API for media providers.
 */

// Types
export type {
	MediaProviderDescriptor,
	MediaProviderCapabilities,
	MediaListOptions,
	MediaListResult,
	MediaProviderItem,
	MediaUploadInput,
	EmbedOptions,
	EmbedResult,
	ImageEmbed,
	VideoEmbed,
	AudioEmbed,
	ComponentEmbed,
	MediaProvider,
	CreateMediaProviderFn,
	MediaValue,
	ThumbnailOptions,
} from "./types.js";

export { mediaItemToValue } from "./types.js";
export { normalizeMediaValue } from "./normalize.js";
export { generatePlaceholder, type PlaceholderData } from "./placeholder.js";
export { enrichImageMetadata, type EnrichedImageMetadata } from "./enrich.js";

// Built-in providers
export { localMedia, type LocalMediaConfig } from "./local.js";
