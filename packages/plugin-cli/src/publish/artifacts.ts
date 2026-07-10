/**
 * Media-artifact resolution for the publish flow.
 *
 * Given the bytes of an image file and the public URL it's hosted at, build
 * the `#artifact` record the release embeds: the multibase-multihash checksum,
 * the MIME content type, and the pixel dimensions. Dimensions come from
 * `image-size`, which reads only the header bytes (no decode), so it's cheap
 * and works for PNG / JPEG / WebP / GIF / AVIF.
 *
 * Kept filesystem- and network-free so it tests against raw byte fixtures.
 * The CLI command reads files and uploads them; this module turns bytes +
 * URL into a record.
 */

import { imageSize } from "image-size";

import { sha256Multihash } from "../multihash.js";

/** An artifact record ready to embed in a release. Mirrors `release.json#artifact`. */
export interface ArtifactRecord {
	url: string;
	checksum: string;
	contentType: string;
	width: number;
	height: number;
	lang?: string;
}

/**
 * Image formats `image-size` reports that we accept as plugin artifacts, mapped
 * to their canonical MIME type. The `type` field is the format name from the
 * header sniff; we don't trust a file extension for the content type.
 */
/** Per-dimension pixel ceiling, matching `release.json#artifact.width/height`. */
const MAX_ARTIFACT_DIMENSION = 8192;

const TYPE_TO_CONTENT_TYPE: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
};

/** Thrown when an artifact file isn't a supported image. */
export class ArtifactError extends Error {
	override readonly name = "ArtifactError";
	readonly code: "ARTIFACT_UNSUPPORTED" | "ARTIFACT_UNREADABLE";

	constructor(code: "ARTIFACT_UNSUPPORTED" | "ARTIFACT_UNREADABLE", message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Sniff `bytes` as an image and return its content type and dimensions. Throws
 * `ArtifactError` when the bytes aren't a supported image or carry no usable
 * dimensions.
 */
export function measureImage(bytes: Uint8Array): {
	contentType: string;
	width: number;
	height: number;
} {
	let result: { width?: number; height?: number; type?: string };
	try {
		result = imageSize(bytes);
	} catch (error) {
		throw new ArtifactError(
			"ARTIFACT_UNREADABLE",
			`Artifact is not a recognised image: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const type = result.type;
	if (type === undefined || !(type in TYPE_TO_CONTENT_TYPE)) {
		throw new ArtifactError(
			"ARTIFACT_UNSUPPORTED",
			`Artifact image format ${type ? `"${type}"` : "(unknown)"} is not supported. Use PNG, JPEG, WebP, GIF, or AVIF.`,
		);
	}
	const { width, height } = result;
	if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) {
		throw new ArtifactError(
			"ARTIFACT_UNSUPPORTED",
			"Artifact image has no readable pixel dimensions.",
		);
	}
	// The lexicon caps artifact dimensions at 8192px; a larger image would be
	// rejected at publish-time lexicon validation with an opaque error.
	if (width > MAX_ARTIFACT_DIMENSION || height > MAX_ARTIFACT_DIMENSION) {
		throw new ArtifactError(
			"ARTIFACT_UNSUPPORTED",
			`Artifact image is ${width}x${height}px; each dimension must be <= ${MAX_ARTIFACT_DIMENSION}px.`,
		);
	}
	return { contentType: TYPE_TO_CONTENT_TYPE[type]!, width, height };
}

/**
 * Build the `#artifact` record for an image hosted at `url`. Computes the
 * checksum from the same bytes the consumer will fetch, and reads the
 * dimensions and content type from the header. `lang` is carried through when
 * the manifest set it.
 */
export function buildArtifactRecord(input: {
	bytes: Uint8Array;
	url: string;
	lang?: string;
}): ArtifactRecord {
	const { contentType, width, height } = measureImage(input.bytes);
	const record: ArtifactRecord = {
		url: input.url,
		checksum: sha256Multihash(input.bytes),
		contentType,
		width,
		height,
	};
	if (input.lang !== undefined) record.lang = input.lang;
	return record;
}
