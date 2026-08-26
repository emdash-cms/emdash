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
export const WORKERS_AI_IMAGE_MODEL_CANDIDATE = "@cf/qwen/qwen3.8-27b";

export interface WorkersAiAdapterConfig {
	modelId: string;
	promptHash: string;
	maxTokens?: number;
	maxCompletionTokens?: number;
	temperature?: number;
	seed?: number;
	thinking?: boolean;
	reasoningEffort?: "low" | "medium" | "high";
	configuredUnits?: number;
	timeoutMs?: number;
}

export interface WorkersAiBinding {
	run(
		model: string,
		input: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<unknown>;
}

export function workersAiBindingFromEnv(ai: Ai): WorkersAiBinding {
	return {
		run(model, input, options) {
			return ai.run(model, input, options);
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
			const response = await ai.run(
				config.modelId,
				{
					messages: [
						{ role: "system", content: TEXT_SYSTEM_PROMPT },
						{
							role: "user",
							content: textModerationXml(request.text, request.links),
						},
					],
					response_format: {
						type: "json_schema",
						json_schema: {
							name: "emdash_listing_moderation",
							strict: true,
							schema: MODERATION_OUTPUT_JSON_SCHEMA,
						},
					},
					...completionTokenParameters(parameters),
					temperature: parameters.temperature,
					seed: parameters.seed,
					...(parameters.reasoningEffort === undefined
						? {}
						: { reasoning_effort: parameters.reasoningEffort }),
					...(parameters.thinking === undefined
						? {}
						: { chat_template_kwargs: { enable_thinking: parameters.thinking } }),
				},
				{ signal: AbortSignal.timeout(parameters.timeoutMs) },
			);
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
			const response = await ai.run(
				config.modelId,
				{
					messages: [
						{ role: "system", content: IMAGE_SYSTEM_PROMPT },
						{
							role: "user",
							content: [
								{
									type: "text",
									text: imageModerationXml(request.evidenceRef, request.mimeType),
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
						json_schema: {
							name: "emdash_listing_moderation",
							strict: true,
							schema: MODERATION_OUTPUT_JSON_SCHEMA,
						},
					},
					...completionTokenParameters(parameters),
					temperature: parameters.temperature,
					seed: parameters.seed,
					...(parameters.reasoningEffort === undefined
						? {}
						: { reasoning_effort: parameters.reasoningEffort }),
					...(parameters.thinking === undefined
						? {}
						: { chat_template_kwargs: { enable_thinking: parameters.thinking } }),
				},
				{ signal: AbortSignal.timeout(parameters.timeoutMs) },
			);
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
	maxTokens?: number;
	maxCompletionTokens?: number;
	temperature: number;
	seed: number;
	thinking?: boolean;
	reasoningEffort?: "low" | "medium" | "high";
	timeoutMs: number;
}> {
	if (config.maxTokens !== undefined && config.maxCompletionTokens !== undefined) {
		throw new TypeError("Workers AI token limits are mutually exclusive");
	}
	const maxTokens =
		config.maxCompletionTokens === undefined ? (config.maxTokens ?? 1024) : undefined;
	const maxCompletionTokens = config.maxCompletionTokens;
	const tokenLimit = maxCompletionTokens ?? maxTokens!;
	const temperature = config.temperature ?? 0;
	const seed = config.seed ?? 1;
	const timeoutMs = config.timeoutMs ?? 20_000;
	if (!Number.isInteger(tokenLimit) || tokenLimit < 128 || tokenLimit > 4096) {
		throw new TypeError("Workers AI token limit must be an integer between 128 and 4096");
	}
	if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
		throw new TypeError("Workers AI temperature must be between zero and one");
	}
	if (!Number.isSafeInteger(seed)) throw new TypeError("Workers AI seed must be a safe integer");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
		throw new TypeError("Workers AI timeout must be an integer between 1 and 300000 milliseconds");
	}
	if (
		config.configuredUnits !== undefined &&
		(!Number.isFinite(config.configuredUnits) || config.configuredUnits < 0)
	) {
		throw new TypeError("Workers AI configuredUnits must be a non-negative finite number");
	}
	return {
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
		temperature,
		seed,
		timeoutMs,
		...(config.thinking === undefined ? {} : { thinking: config.thinking }),
		...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
	};
}

function completionTokenParameters(
	parameters: ReturnType<typeof adapterParameters>,
): Record<string, number> {
	return parameters.maxCompletionTokens === undefined
		? { max_tokens: parameters.maxTokens! }
		: { max_completion_tokens: parameters.maxCompletionTokens };
}

function textModerationXml(
	text: readonly { ref: string; value: string; format: string }[],
	links: readonly { ref: string; url: string; usage: string }[],
): string {
	return [
		'<listing-input schema-version="1">',
		"<text-fields>",
		...text.map(
			(field) =>
				`<text ref="${xmlEscape(field.ref)}" format="${xmlEscape(field.format)}">${xmlEscape(field.value)}</text>`,
		),
		"</text-fields>",
		"<links>",
		...links.map(
			(link) =>
				`<link ref="${xmlEscape(link.ref)}" usage="${xmlEscape(link.usage)}">${xmlEscape(link.url)}</link>`,
		),
		"</links>",
		"</listing-input>",
	].join("\n");
}

function imageModerationXml(evidenceRef: string, mimeType: string): string {
	return [
		'<image-input schema-version="1">',
		`<evidence-ref>${xmlEscape(evidenceRef)}</evidence-ref>`,
		`<mime-type>${xmlEscape(mimeType)}</mime-type>`,
		"</image-input>",
	].join("\n");
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
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
	const output = structuredModelOutput(provider);
	if (output === undefined) {
		throw new TypeError(
			`Workers AI response is missing structured model output (${modelOutputShape(provider)})`,
		);
	}
	const parsed = parseModerationModelOutput(output, evidenceRefs);
	return {
		...parsed,
		identity,
		latencyMs,
		usage: parseUsage(provider["usage"], config.configuredUnits),
	};
}

function structuredModelOutput(provider: Record<string, unknown>): string | undefined {
	if (typeof provider["response"] === "string") return provider["response"];
	if (isObject(provider["response"])) return JSON.stringify(provider["response"]);
	const choices = provider["choices"];
	if (!Array.isArray(choices) || !isObject(choices[0])) return undefined;
	const message = choices[0]["message"];
	if (!isObject(message)) return undefined;
	if (typeof message["content"] === "string") return message["content"];
	if (isObject(message["content"])) return JSON.stringify(message["content"]);
	return undefined;
}

function modelOutputShape(provider: Record<string, unknown>): string {
	const choices = provider["choices"];
	if (!Array.isArray(choices) || !isObject(choices[0])) {
		return `keys=${Object.keys(provider).toSorted().join(",")}`;
	}
	const message = choices[0]["message"];
	return `choice.finish_reason=${String(choices[0]["finish_reason"])};message.content=${
		isObject(message) ? typeof message["content"] : "missing"
	};message.refusal=${isObject(message) && typeof message["refusal"] === "string" ? "present" : "absent"}`;
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
