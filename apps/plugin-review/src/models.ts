import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai/compat";

import { ReviewDeclinedError, type ReviewModel } from "./agent.js";

export interface GatewayEnv {
	readonly AI_GATEWAY_ACCOUNT_ID?: string;
	readonly AI_GATEWAY_NAME?: string;
	readonly AI_GATEWAY_TOKEN?: string;
}

type GatewayProvider = "anthropic" | "openai" | "workers-ai";

const TRANSIENT_ERROR_RE = /overloaded_error|api_error|rate_limit_error|timeout/i;
const OPENAI_POLICY_BLOCK_RE = /\bflagged for possible\b/i;

const MODEL_LIMITS = { contextWindow: 262_144, maxTokens: 32_000 };

const ANTHROPIC_COMPAT = {
	sendSessionAffinityHeaders: true,
	forceAdaptiveThinking: true,
	supportsTemperature: false,
};

const OPENAI_REASONING: Partial<Model<Api>> = {
	reasoning: true,
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	compat: { supportsStrictMode: true },
};

// The bundled pi-ai catalog predates these models; without this metadata the
// wire protocols treat them as non-reasoning models and drop the thinking level.
const MODEL_METADATA: Record<string, Partial<Model<Api>>> = {
	"claude-opus-5-5": {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: ANTHROPIC_COMPAT,
	},
	"claude-sonnet-5-5": {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: ANTHROPIC_COMPAT,
	},
	"gpt-6.1-sol": OPENAI_REASONING,
	"gpt-6.1-terra": OPENAI_REASONING,
	"gpt-6-luna": OPENAI_REASONING,
};

const PROTOCOLS: Record<
	GatewayProvider,
	{ api: Api; streams: () => ProviderStreams; compat?: Model<Api>["compat"] }
> = {
	anthropic: { api: "anthropic-messages", streams: anthropicMessagesApi },
	openai: { api: "openai-responses", streams: openAIResponsesApi },
	"workers-ai": {
		api: "openai-completions",
		streams: openAICompletionsApi,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsLongCacheRetention: false,
		},
	},
};

export const REASONING_LEVELS = ["low", "medium", "high"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export class GatewayConfigurationError extends Error {
	override readonly name = "GatewayConfigurationError";
}

/**
 * A reviewer model reached through an authenticated AI Gateway with Unified
 * Billing. The gateway token stands in for the provider API key.
 */
export function gatewayReviewModel(
	env: GatewayEnv,
	specifier: string,
	options: { reasoning?: ReasoningLevel } = {},
): ReviewModel {
	const account = env.AI_GATEWAY_ACCOUNT_ID?.trim();
	const gateway = env.AI_GATEWAY_NAME?.trim();
	const token = env.AI_GATEWAY_TOKEN?.trim();
	if (!account || !gateway || !token) {
		throw new GatewayConfigurationError("AI Gateway settings are missing");
	}
	const slash = specifier.indexOf("/");
	const provider = specifier.slice(0, slash);
	const id = specifier.slice(slash + 1);
	if (slash <= 0 || !id || !isGatewayProvider(provider)) {
		throw new GatewayConfigurationError(`${specifier} is not an AI Gateway model`);
	}
	const { api, streams, compat } = PROTOCOLS[provider];
	const model: Model<Api> = {
		id,
		name: id,
		api,
		provider,
		baseUrl: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(account)}/${encodeURIComponent(gateway)}/${provider}${provider === "workers-ai" ? "/v1" : ""}`,
		headers: { "cf-aig-authorization": `Bearer ${token}`, "cf-aig-skip-cache": "true" },
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...MODEL_LIMITS,
		...(compat ? { compat } : {}),
		...MODEL_METADATA[id],
	};
	if (options.reasoning) {
		model.reasoning = true;
		if (api === "openai-completions") {
			model.compat = { ...model.compat, supportsReasoningEffort: true };
		}
	}
	const reasoning = options.reasoning ?? (model.reasoning ? "high" : undefined);
	const client = streams();
	return {
		id: specifier,
		complete: async (context, signal) => {
			let status: number | undefined;
			const message = await client
				.streamSimple(model, context, {
					apiKey: token,
					signal,
					onResponse: (response) => {
						status = response.status;
					},
					...(reasoning ? { reasoning } : {}),
				})
				.result();
			if (isDeclined(provider, message, status, signal)) {
				throw new ReviewDeclinedError(
					message.errorMessage ?? `${specifier} refused the review`,
					message,
				);
			}
			return message;
		},
	};
}

// A refusal or safety block arrives on a successful stream; a transport error
// does not. pi-ai reports Anthropic's `refusal` stop reason as an error, and
// keeps only the message of an OpenAI policy error, dropping its code
// (`bio_policy` and similar), so the OpenAI check has to match the message.
function isDeclined(
	provider: GatewayProvider,
	message: AssistantMessage,
	status: number | undefined,
	signal: AbortSignal,
) {
	if (message.stopReason !== "error" || status !== 200 || signal.aborted) return false;
	const text = message.errorMessage ?? "";
	if (provider === "anthropic") return !TRANSIENT_ERROR_RE.test(text);
	if (provider === "openai") return OPENAI_POLICY_BLOCK_RE.test(text);
	return false;
}

function isGatewayProvider(value: string): value is GatewayProvider {
	return value === "anthropic" || value === "openai" || value === "workers-ai";
}
