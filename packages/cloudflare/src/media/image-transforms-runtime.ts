import { env } from "cloudflare:workers";
import type { CreateMediaTransformFn } from "emdash/media";

import type { CloudflareImageTransformsConfig } from "./image-transforms.js";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_WIDTH = 1600;
const DEFAULT_MAX_WIDTH = 2400;
const DEFAULT_QUALITY = 85;

function imageFormatForRequest(request: Request): "image/avif" | "image/webp" {
	const accept = request.headers.get("accept") || "";
	return accept.includes("image/avif") ? "image/avif" : "image/webp";
}

function imageWidthForRequest(request: Request, defaultWidth: number, maxWidth: number): number {
	const width = Number(new URL(request.url).searchParams.get("width"));
	if (!Number.isFinite(width) || width <= 0) return defaultWidth;
	return Math.min(Math.round(width), maxWidth);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error("Image transform timed out")), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timeoutId);
	}
}

function getImagesBinding(binding: string): ImagesBinding | undefined {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Workers bindings are exposed through an untyped env object.
	const value = (env as Record<string, unknown>)[binding];
	if (!isImagesBinding(value)) return undefined;
	return value;
}

function isImagesBinding(value: unknown): value is ImagesBinding {
	return typeof value === "object" && value !== null && "input" in value && typeof value.input === "function";
}

export const createMediaTransform: CreateMediaTransformFn<CloudflareImageTransformsConfig> = (
	config,
) => {
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const defaultWidth = config.defaultWidth ?? DEFAULT_WIDTH;
	const maxWidth = config.maxWidth ?? DEFAULT_MAX_WIDTH;
	const quality = config.quality ?? DEFAULT_QUALITY;

	return async ({ body, request }) => {
		const images = getImagesBinding(config.binding);
		if (!images) return null;

		const input = new Response(body).body;
		if (!input) throw new Error("Unable to create image transform input stream");

		const transformed = await withTimeout(
			images
				.input(input)
				.transform({
					fit: "scale-down",
					width: imageWidthForRequest(request, defaultWidth, maxWidth),
				})
				.output({
					format: imageFormatForRequest(request),
					quality,
				}),
			timeoutMs,
		);

		return {
			body: transformed.image(),
			contentType: transformed.contentType(),
			headers: { Vary: "Accept" },
		};
	};
};
