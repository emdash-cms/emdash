import {
	createCloudflareImagesDerivativeTransformer,
	createResizedImageModerationAdapter,
	DEFAULT_MODERATION_IMAGE_DERIVATIVE_OPTIONS,
	type ImageModerationDerivativeTransformer,
} from "../src/ai/image-resize.js";
import { IMAGE_PROMPT_HASH } from "../src/ai/prompts.js";
import {
	createWorkersAiImageAdapter,
	workersAiBindingFromEnv,
	WORKERS_AI_IMAGE_MODEL_CANDIDATE,
	type WorkersAiBinding,
} from "../src/ai/workers-ai.js";

const IMAGE_DATA_URL_RE = /^data:image\/(?:gif|jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_MANUAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MANUAL_IMAGE_PATH = "/moderate-image";
const MANUAL_IMAGE_TIMEOUT_MS = 120_000;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") return new Response("POST required", { status: 405 });
		let value: unknown;
		try {
			value = await request.json();
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}
		if (new URL(request.url).pathname === MANUAL_IMAGE_PATH) {
			return moderateManualImage(value, env);
		}
		if (!isRecord(value) || typeof value["model"] !== "string" || !isRecord(value["input"])) {
			return new Response("Invalid request", { status: 400 });
		}
		const model = value["model"];
		if (!model.startsWith("@cf/") || model.length > 256) {
			return new Response("Invalid model", { status: 400 });
		}
		try {
			const imageMaxDimension = value["imageMaxDimension"];
			const input =
				typeof imageMaxDimension === "number"
					? await resizeImageInput(value["input"], env.IMAGES, imageMaxDimension)
					: value["input"];
			const result = await workersAiBindingFromEnv(env.AI).run(model, input);
			if (result instanceof Response) return result;
			if (result instanceof ReadableStream) {
				return new Response(result, { headers: { "content-type": "application/json" } });
			}
			return Response.json(result);
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : "Workers AI request failed" },
				{ status: 502 },
			);
		}
	},
} satisfies ExportedHandler<Env>;

export function parseManualImageRequest(value: unknown): {
	fileName: string;
	mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
	bytes: Uint8Array;
} {
	if (!isRecord(value)) throw new TypeError("manual image request must be an object");
	const fileName = value["fileName"];
	if (
		typeof fileName !== "string" ||
		fileName.length < 1 ||
		fileName.length > 255 ||
		fileName.includes("/") ||
		fileName.includes("\\")
	) {
		throw new TypeError("manual image file name is invalid");
	}
	const mimeType = value["mimeType"];
	if (
		mimeType !== "image/gif" &&
		mimeType !== "image/jpeg" &&
		mimeType !== "image/png" &&
		mimeType !== "image/webp"
	) {
		throw new TypeError("manual image MIME type is unsupported");
	}
	const encoded = value["base64"];
	if (
		typeof encoded !== "string" ||
		encoded.length > Math.ceil(MAX_MANUAL_IMAGE_BYTES / 3) * 4 + 4 ||
		!BASE64_RE.test(encoded)
	) {
		throw new TypeError("manual image data is not bounded canonical base64");
	}
	const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
	if (bytes.byteLength > MAX_MANUAL_IMAGE_BYTES) {
		throw new RangeError("manual image exceeds its byte limit");
	}
	return { fileName, mimeType, bytes };
}

async function moderateManualImage(value: unknown, env: Env): Promise<Response> {
	let input: ReturnType<typeof parseManualImageRequest>;
	try {
		input = parseManualImageRequest(value);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "manual image request is invalid" },
			{ status: 400 },
		);
	}
	try {
		const adapter = createManualImageModerationAdapter(
			workersAiBindingFromEnv(env.AI),
			createCloudflareImagesDerivativeTransformer(env.IMAGES),
		);
		const result = await adapter.moderate({
			subject: {
				uri: "at://did:plc:manualimageevaluation/com.emdashcms.experimental.package.release/local:0.0.0",
				cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				kind: "release",
			},
			evidenceRef: "manual.image:0",
			mimeType: input.mimeType,
			bytes: input.bytes,
		});
		return Response.json({
			fileName: input.fileName,
			outcome: result.findings.length === 0 ? "pass" : "review",
			findings: result.findings,
			coveredEvidenceRefs: result.coveredEvidenceRefs,
			identity: result.identity,
			latencyMs: result.latencyMs,
			usage: result.usage,
		});
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "manual image evaluation failed" },
			{ status: 502 },
		);
	}
}

export function createManualImageModerationAdapter(
	ai: WorkersAiBinding,
	transformer: ImageModerationDerivativeTransformer,
) {
	const baseAdapter = createWorkersAiImageAdapter(ai, {
		modelId: WORKERS_AI_IMAGE_MODEL_CANDIDATE,
		promptHash: IMAGE_PROMPT_HASH,
		thinking: false,
		timeoutMs: MANUAL_IMAGE_TIMEOUT_MS,
	});
	return createResizedImageModerationAdapter(
		transformer,
		baseAdapter,
		DEFAULT_MODERATION_IMAGE_DERIVATIVE_OPTIONS,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resizeImageInput(
	input: Record<string, unknown>,
	images: ImagesBinding,
	maxDimension: number,
): Promise<Record<string, unknown>> {
	if (!Number.isInteger(maxDimension) || maxDimension < 256 || maxDimension > 2048) {
		throw new TypeError("imageMaxDimension must be an integer between 256 and 2048");
	}
	const nativeImage = input["image"];
	let transformedInput = input;
	if (typeof nativeImage === "string") {
		transformedInput = {
			...input,
			image: dataUrl(await resizeImage(parseDataUrl(nativeImage), images, maxDimension)),
		};
	} else if (Array.isArray(nativeImage)) {
		const bytes = parseImageByteArray(nativeImage);
		transformedInput = {
			...input,
			image: [...(await resizeImage(bytes, images, maxDimension))],
		};
	}
	const messages = transformedInput["messages"];
	if (!Array.isArray(messages)) return transformedInput;
	const transformedMessages = await Promise.all(
		messages.map(async (message) => {
			if (!isRecord(message) || !Array.isArray(message["content"])) return message;
			return {
				...message,
				content: await Promise.all(
					message["content"].map(async (part) => {
						if (!isRecord(part) || part["type"] !== "image_url" || !isRecord(part["image_url"])) {
							return part;
						}
						const url = part["image_url"]["url"];
						if (typeof url !== "string") return part;
						const bytes = parseDataUrl(url);
						const resized = await resizeImage(bytes, images, maxDimension);
						return { ...part, image_url: { ...part["image_url"], url: dataUrl(resized) } };
					}),
				),
			};
		}),
	);
	return { ...transformedInput, messages: transformedMessages };
}

export function parseImageByteArray(value: readonly unknown[]): Uint8Array {
	return Uint8Array.from(value, (byte, index) => {
		if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
			throw new TypeError(`image byte at index ${index} is not a valid uint8 value`);
		}
		return byte;
	});
}

async function resizeImage(
	bytes: Uint8Array,
	images: ImagesBinding,
	maxDimension: number,
): Promise<Uint8Array> {
	const output = await images
		.input(new Blob([bytes]).stream())
		.transform({ width: maxDimension, height: maxDimension, fit: "scale-down" })
		.output({ format: "image/webp", quality: 85, anim: false });
	return new Uint8Array(await new Response(output.image()).arrayBuffer());
}

function parseDataUrl(value: string): Uint8Array {
	const match = IMAGE_DATA_URL_RE.exec(value);
	const encoded = match?.[1];
	if (!encoded) throw new TypeError("image input is not a supported base64 data URL");
	return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function dataUrl(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return `data:image/webp;base64,${btoa(binary)}`;
}
