import { sha256Hex } from "./hash.js";
import { parseModerationModelOutput } from "./output.js";
import {
	IMAGE_PROMPT_VERSION,
	IMAGE_SYSTEM_PROMPT,
	MODERATION_OUTPUT_JSON_SCHEMA,
	TEXT_PROMPT_VERSION,
	TEXT_SYSTEM_PROMPT,
} from "./prompts.js";
import {
	AI_ADAPTER_VERSION,
	type ImageModerationAdapter,
	type ImageModerationRequest,
	type ModerationInferenceResult,
	type ModerationModelIdentity,
	type ModerationUsage,
	type TextModerationAdapter,
} from "./types.js";

export const WORKERS_AI_TEXT_MODEL_CANDIDATE = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORKERS_AI_IMAGE_MODEL_CANDIDATE = "@cf/meta/llama-4-scout-17b-16e-instruct";

export interface WorkersAiAdapterConfig {
	modelId: string;
	promptHash: string;
	maxTokens?: number;
	temperature?: number;
	seed?: number;
	configuredUnits?: number;
}

export interface WorkersAiBinding {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export function workersAiBindingFromEnv(ai: Ai): WorkersAiBinding {
	return {
		run(model, input) {
			return ai.run(model, input);
		},
	};
}

export function createWorkersAiTextAdapter(
	ai: WorkersAiBinding,
	config: WorkersAiAdapterConfig,
): TextModerationAdapter {
	const parameters = adapterParameters(config);
	const identity: ModerationModelIdentity = {
		adapterVersion: AI_ADAPTER_VERSION,
		modelId: config.modelId,
		promptVersion: TEXT_PROMPT_VERSION,
		promptHash: config.promptHash,
		parameters,
	};
	let promptCheck: Promise<void> | undefined;
	return {
		identity,
		async moderate(request) {
			promptCheck ??= assertPromptHash(TEXT_SYSTEM_PROMPT, config.promptHash);
			await promptCheck;
			const evidenceRefs = [
				...request.text.map((field) => field.ref),
				...request.links.map((field) => field.ref),
			];
			assertUniqueEvidenceRefs(evidenceRefs);
			const started = performance.now();
			const response = await ai.run(config.modelId, {
				messages: [
					{ role: "system", content: TEXT_SYSTEM_PROMPT },
					{
						role: "user",
						content: JSON.stringify({
							schemaVersion: 1,
							text: request.text,
							links: request.links,
						}),
					},
				],
				response_format: {
					type: "json_schema",
					json_schema: MODERATION_OUTPUT_JSON_SCHEMA,
				},
				max_tokens: parameters.maxTokens,
				temperature: parameters.temperature,
				seed: parameters.seed,
			});
			return normalizeResponse(
				response,
				evidenceRefs,
				identity,
				performance.now() - started,
				config,
			);
		},
	};
}

export function createWorkersAiImageAdapter(
	ai: WorkersAiBinding,
	config: WorkersAiAdapterConfig,
): ImageModerationAdapter {
	const parameters = adapterParameters(config);
	const identity: ModerationModelIdentity = {
		adapterVersion: AI_ADAPTER_VERSION,
		modelId: config.modelId,
		promptVersion: IMAGE_PROMPT_VERSION,
		promptHash: config.promptHash,
		parameters,
	};
	let promptCheck: Promise<void> | undefined;
	return {
		identity,
		async moderate(request) {
			promptCheck ??= assertPromptHash(IMAGE_SYSTEM_PROMPT, config.promptHash);
			await promptCheck;
			const started = performance.now();
			const response = await ai.run(config.modelId, {
				messages: [
					{ role: "system", content: IMAGE_SYSTEM_PROMPT },
					{
						role: "user",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									schemaVersion: 1,
									evidenceRef: request.evidenceRef,
									mimeType: request.mimeType,
								}),
							},
							{
								type: "image_url",
								image_url: { url: dataUrl(request.mimeType, request.bytes) },
							},
						],
					},
				],
				response_format: {
					type: "json_schema",
					json_schema: MODERATION_OUTPUT_JSON_SCHEMA,
				},
				max_tokens: parameters.maxTokens,
				temperature: parameters.temperature,
				seed: parameters.seed,
			});
			return normalizeResponse(
				response,
				[request.evidenceRef],
				identity,
				performance.now() - started,
				config,
			);
		},
	};
}

function adapterParameters(config: WorkersAiAdapterConfig): Readonly<{
	maxTokens: number;
	temperature: number;
	seed: number;
}> {
	const maxTokens = config.maxTokens ?? 1024;
	const temperature = config.temperature ?? 0;
	const seed = config.seed ?? 1;
	if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 4096) {
		throw new TypeError("Workers AI maxTokens must be an integer between 128 and 4096");
	}
	if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
		throw new TypeError("Workers AI temperature must be between zero and one");
	}
	if (!Number.isSafeInteger(seed)) throw new TypeError("Workers AI seed must be a safe integer");
	if (
		config.configuredUnits !== undefined &&
		(!Number.isFinite(config.configuredUnits) || config.configuredUnits < 0)
	) {
		throw new TypeError("Workers AI configuredUnits must be a non-negative finite number");
	}
	return { maxTokens, temperature, seed };
}

async function assertPromptHash(prompt: string, expected: string): Promise<void> {
	const actual = await sha256Hex(prompt);
	if (actual !== expected)
		throw new Error("configured prompt hash does not match production prompt");
}

function normalizeResponse(
	response: unknown,
	evidenceRefs: readonly string[],
	identity: ModerationModelIdentity,
	latencyMs: number,
	config: WorkersAiAdapterConfig,
): ModerationInferenceResult {
	if (!isObject(response)) {
		throw new TypeError("Workers AI response must be an object");
	}
	const provider = response;
	if (typeof provider["response"] !== "string") {
		throw new TypeError("Workers AI response is missing structured model output");
	}
	const parsed = parseModerationModelOutput(provider["response"], evidenceRefs);
	return {
		...parsed,
		identity,
		latencyMs,
		usage: parseUsage(provider["usage"], config.configuredUnits),
	};
}

function parseUsage(value: unknown, configuredUnits?: number): ModerationUsage {
	const usage: ModerationUsage = { configuredUnits };
	if (!isObject(value)) return usage;
	const record = value;
	for (const [source, target] of [
		["prompt_tokens", "inputTokens"],
		["completion_tokens", "outputTokens"],
		["total_tokens", "totalTokens"],
	] as const) {
		const count = record[source];
		if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
			usage[target] = count;
	}
	return usage;
}

function assertUniqueEvidenceRefs(refs: readonly string[]): void {
	if (new Set(refs).size !== refs.length) {
		throw new TypeError("moderation request evidence references must be unique");
	}
}

function dataUrl(mimeType: ImageModerationRequest["mimeType"], bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 8192;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
