import { workersAiBindingFromEnv } from "../src/ai/workers-ai.js";

interface SweepEnv {
	AI: Ai;
	IMAGES: ImagesBinding;
}

const IMAGE_DATA_URL_RE = /^data:image\/(?:gif|jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

export default {
	async fetch(request: Request, env: SweepEnv): Promise<Response> {
		if (request.method !== "POST") return new Response("POST required", { status: 405 });
		let value: unknown;
		try {
			value = await request.json();
		} catch {
			return new Response("Invalid JSON", { status: 400 });
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
};

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
		const bytes = Uint8Array.from(nativeImage.map((value) => Number(value)));
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
