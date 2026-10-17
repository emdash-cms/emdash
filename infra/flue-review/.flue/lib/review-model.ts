import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai/compat";
import { registerApiProvider, registerProvider } from "@flue/runtime";

// Kimi K2.7 Code via the Workers AI binding: no model API key needed.
export const DEFAULT_REVIEW_MODEL = "cloudflare/@cf/moonshotai/kimi-k2.7-code";

// Keeps vendor models within the same compaction budget as the default model,
// so model comparisons do not also compare context sizes.
const GATEWAY_MODEL_LIMITS = { contextWindow: 262_144, maxTokens: 64_000 };

export interface ReviewModelEnv {
	readonly REVIEW_MODEL?: string;
	readonly AI_GATEWAY_ACCOUNT_ID?: string;
	readonly AI_GATEWAY_NAME?: string;
	readonly AI_GATEWAY_TOKEN?: string;
}

export function reviewModel(env: ReviewModelEnv): string {
	return env.REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
}

// The bundled catalog predates these models, so Flue would build them as
// zero-metadata, non-reasoning models and the wire protocols would drop the
// agent's thinking level. These wrappers restore the catalog metadata the
// AI Gateway catalog publishes for them before delegating to the stock protocol.
type GatewayModelId = "claude-opus-5-5" | "gpt-6.1-sol";

const GATEWAY_MODELS: Record<
	GatewayModelId,
	{ api: Api; streams: ProviderStreams; metadata: Partial<Model<Api>> }
> = {
	"claude-opus-5-5": {
		api: "anthropic-messages",
		streams: anthropicMessagesApi(),
		metadata: {
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			compat: {
				sendSessionAffinityHeaders: true,
				forceAdaptiveThinking: true,
				supportsTemperature: false,
			},
		},
	},
	"gpt-6.1-sol": {
		api: "openai-responses",
		streams: openAIResponsesApi(),
		metadata: {
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
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
		},
	},
};

const GATEWAY_API_PREFIX = "review-gateway:";

function registerReasoningApi(modelId: GatewayModelId): string {
	const { api, streams, metadata } = GATEWAY_MODELS[modelId];
	const withMetadata = (model: Model<Api>): Model<Api> => ({ ...model, ...metadata, api });
	const wrapped: ProviderStreams = {
		stream: (model, context, options) => streams.stream(withMetadata(model), context, options),
		streamSimple: (model, context, options) =>
			streams.streamSimple(withMetadata(model), context, options),
	};
	const name = `${GATEWAY_API_PREFIX}${modelId}`;
	registerApiProvider({ api: name, ...wrapped });
	return name;
}

/**
 * Routes the `anthropic` and `openai` providers through an authenticated AI
 * Gateway with Unified Billing. The gateway accepts its own token in place of
 * a provider key and rejects any real-looking provider key it does not own, so
 * the gateway token is also the provider API key. Returns false, registering
 * nothing, unless all three gateway settings are present.
 */
export function registerGatewayProviders(env: ReviewModelEnv): boolean {
	const accountId = env.AI_GATEWAY_ACCOUNT_ID;
	const gatewayId = env.AI_GATEWAY_NAME;
	const token = env.AI_GATEWAY_TOKEN;
	if (!accountId || !gatewayId || !token) return false;
	const base = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}`;
	const headers = {
		"cf-aig-authorization": `Bearer ${token}`,
		"cf-aig-skip-cache": "true",
	};
	registerProvider("anthropic", {
		api: registerReasoningApi("claude-opus-5-5"),
		baseUrl: `${base}/anthropic`,
		apiKey: token,
		headers,
		models: { "claude-opus-5-5": GATEWAY_MODEL_LIMITS },
	});
	registerProvider("openai", {
		api: registerReasoningApi("gpt-6.1-sol"),
		baseUrl: `${base}/openai`,
		apiKey: token,
		headers,
		models: { "gpt-6.1-sol": GATEWAY_MODEL_LIMITS },
	});
	return true;
}
