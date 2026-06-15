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

// Built-in providers
export { localMedia, type LocalMediaConfig } from "./local.js";

// Image transform service (binding-based, same-origin media)
export type {
	ImageServiceDescriptor,
	ImageTransformer,
	ImageTransformOptions,
	ImageTransformFormat,
	TransformImageFn,
	TransformedImage,
	CreateImageTransformerFn,
} from "./image-transform.js";
export {
	ALLOWED_TRANSFORM_FORMATS,
	DEFAULT_TRANSFORM_FORMAT,
	MAX_TRANSFORM_WIDTH,
	TRANSFORM_MEDIA_PREFIX,
	buildTransformUrl,
	buildTransformSrcset,
	buildTransformedImage,
	isSafeTransformKey,
	isTransformFormat,
	parseTransformParams,
} from "./image-transform.js";
