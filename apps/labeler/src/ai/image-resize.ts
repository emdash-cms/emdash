import type { ImageModerationAdapter, ImageModerationRequest } from "./types.js";

const DEFAULT_MAX_DERIVATIVE_BYTES = 4 * 1024 * 1024;

export const DEFAULT_MODERATION_IMAGE_DERIVATIVE_OPTIONS = Object.freeze({
	maxDimension: 512,
	format: "image/webp" as const,
	quality: 85,
});

export interface ImageModerationDerivativeOptions {
	maxDimension: number;
	format: "image/webp";
	quality: number;
}

export interface ImageModerationDerivativeTransformer {
	resize(
		request: ImageModerationRequest,
		options: ImageModerationDerivativeOptions,
	): Promise<{ bytes: Uint8Array; mimeType: "image/webp" }>;
}

export function createResizedImageModerationAdapter(
	transformer: ImageModerationDerivativeTransformer,
	delegate: ImageModerationAdapter,
	options: ImageModerationDerivativeOptions,
): ImageModerationAdapter {
	assertOptions(options);
	return {
		identity: {
			...delegate.identity,
			parameters: {
				...delegate.identity.parameters,
				imageMaxDimension: options.maxDimension,
				imageFormat: options.format,
				imageQuality: options.quality,
			},
		},
		async moderate(request) {
			const derivative = await transformer.resize(request, options);
			return delegate.moderate({
				...request,
				bytes: derivative.bytes,
				mimeType: derivative.mimeType,
			});
		},
	};
}

export function createCloudflareImagesDerivativeTransformer(
	images: ImagesBinding,
	maxBytes = DEFAULT_MAX_DERIVATIVE_BYTES,
): ImageModerationDerivativeTransformer {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new TypeError("image moderation derivative byte limit is invalid");
	}
	return {
		async resize(request, options) {
			const output = await images
				.input(new Blob([new Uint8Array(request.bytes)]).stream())
				.transform({
					width: options.maxDimension,
					height: options.maxDimension,
					fit: "scale-down",
				})
				.output({ format: options.format, quality: options.quality, anim: false });
			return {
				bytes: await readBoundedStream(output.image(), maxBytes),
				mimeType: "image/webp",
			};
		},
	};
}

function assertOptions(options: ImageModerationDerivativeOptions): void {
	if (
		!Number.isInteger(options.maxDimension) ||
		options.maxDimension < 256 ||
		options.maxDimension > 2048
	) {
		throw new TypeError("image moderation max dimension must be between 256 and 2048");
	}
	if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) {
		throw new TypeError("image moderation quality must be between 1 and 100");
	}
}

async function readBoundedStream(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			total += item.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel("image moderation derivative exceeds its byte limit");
				throw new RangeError("image moderation derivative exceeds its byte limit");
			}
			chunks.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}
