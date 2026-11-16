import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai/compat";

import type { ReviewModel } from "./agent.js";

export interface GatewayEnv {
	readonly AI_GATEWAY_ACCOUNT_ID?: string;
	readonly AI_GATEWAY_NAME?: string;
	readonly AI_GATEWAY_TOKEN?: string;
}

type GatewayProvider = "anthropic" | "openai";

const MODEL_LIMITS = { contextWindow: 262_144, maxTokens: 32_000 };

const ANTHROPIC_COMPAT = {
	sendSessionAffinityHeaders: true,
	forceAdaptiveThinking: true,
	supportsTemperature: false,
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
	"gpt-6.1-sol": {
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
	},
};

const PROTOCOLS: Record<GatewayProvider, { api: Api; streams: () => ProviderStreams }> = {
	anthropic: { api: "anthropic-messages", streams: anthropicMessagesApi },
	openai: { api: "openai-responses", streams: openAIResponsesApi },
};

export class GatewayConfigurationError extends Error {
	override readonly name = "GatewayConfigurationError";
}

/**
 * A reviewer model reached through an authenticated AI Gateway with Unified
 * Billing. The gateway token stands in for the provider API key.
 */
export function gatewayReviewModel(env: GatewayEnv, specifier: string): ReviewModel {
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
	const { api, streams } = PROTOCOLS[provider];
	const model: Model<Api> = {
		id,
		name: id,
		api,
		provider,
		baseUrl: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(account)}/${encodeURIComponent(gateway)}/${provider}`,
		headers: { "cf-aig-authorization": `Bearer ${token}`, "cf-aig-skip-cache": "true" },
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...MODEL_LIMITS,
		...MODEL_METADATA[id],
	};
	const client = streams();
	return {
		id: specifier,
		complete: (context, signal) =>
			client
				.streamSimple(model, context, {
					apiKey: token,
					signal,
					...(model.reasoning ? { reasoning: "high" } : {}),
				})
				.result(),
	};
}

function isGatewayProvider(value: string): value is GatewayProvider {
	return value === "anthropic" || value === "openai";
}
