/**
 * Cloudflare image endpoint -- the `image.endpoint` EmDash installs under the
 * Cloudflare adapter.
 *
 * For an EmDash media URL it reads the source bytes straight from the storage
 * adapter (the R2 binding) and resizes them with the Cloudflare `IMAGES`
 * binding -- no HTTP fetch, so it works behind Cloudflare Access and with
 * `global_fetch_strictly_public`. Every other image is delegated to the
 * adapter's stock transform endpoint unchanged (bundled assets via the `ASSETS`
 * binding, allowed-remote via fetch).
 */

// @astrojs/cloudflare's binding-mode transform endpoint; resolved in the consumer.
import { GET as adapterGET } from "@astrojs/cloudflare/image-transform-endpoint";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import type { Storage } from "emdash";
import {
	IMMUTABLE_IMAGE_CACHE,
	matchInternalMediaKey,
	originalMediaHeaders,
	parseTransformParams,
	type ImageTransformFormat,
} from "emdash/media/image-endpoint";

export const prerender = false;

const FORMAT_MIME: Record<ImageTransformFormat, ImageOutputOptions["format"]> = {
	webp: "image/webp",
	avif: "image/avif",
	jpeg: "image/jpeg",
	png: "image/png",
};

/** Resolve the Images binding by the name the Cloudflare adapter configured. */
function resolveImagesBinding(): ImagesBinding | undefined {
	const configured = (globalThis as { __ASTRO_IMAGES_BINDING_NAME?: unknown })
		.__ASTRO_IMAGES_BINDING_NAME;
	const name = typeof configured === "string" && configured ? configured : "IMAGES";
	// env from cloudflare:workers has no index signature, so a cast is needed.
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Images binding accessed from untyped env object
	return (env as Record<string, unknown>)[name] as ImagesBinding | undefined;
}

function streamOriginal(body: ReadableStream<Uint8Array>, contentType: string): Response {
	return new Response(body, { status: 200, headers: originalMediaHeaders(contentType) });
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
	);
}

export const GET: APIRoute = async (ctx) => {
	const url = new URL(ctx.request.url);
	const key = matchInternalMediaKey(url.searchParams.get("href"));
	// App.Locals.emdash is augmented by `emdash/locals`, not loaded in this
	// package's compilation; narrow to the field we need.
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- App.Locals augmentation lives in the emdash package
	const storage = (ctx.locals as { emdash?: { storage?: Storage | null } }).emdash?.storage;

	// Not EmDash media, or storage unavailable: let the adapter's endpoint handle
	// it (bundled assets via ASSETS, allowed remote via fetch).
	if (!key || !storage) return adapterGET(ctx);

	try {
		const source = await storage.download(key);

		// Only raster images are transformable; serve anything else unchanged.
		if (!source.contentType.startsWith("image/")) {
			return streamOriginal(source.body, source.contentType);
		}

		const images = resolveImagesBinding();
		const parsed = parseTransformParams(url.searchParams);

		// No binding or unparseable params: serve the original so the URL resolves.
		if (!images || !parsed.ok) {
			return streamOriginal(source.body, source.contentType);
		}

		const { width, height, format, quality } = parsed.options;
		const outputMime = FORMAT_MIME[format] ?? "image/webp";
		const transform: ImageTransform = {};
		if (width) transform.width = width;
		if (height) transform.height = height;
		const output: ImageOutputOptions = { format: outputMime };
		if (quality) output.quality = quality;

		const result = await images.input(source.body).transform(transform).output(output);
		const response = result.response();
		if (!response.body) return new Response(null, { status: 500 });

		return new Response(response.body, {
			status: 200,
			headers: {
				"Content-Type": response.headers.get("Content-Type") ?? outputMime,
				"Cache-Control": IMMUTABLE_IMAGE_CACHE,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		if (isNotFound(error)) return new Response("Not Found", { status: 404 });
		console.error("[emdash] image transform failed:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
};
