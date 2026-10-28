import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type {
	Api,
	Model,
	ProviderStreams,
	ThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { registerApiProvider, registerProvider } from "@flue/runtime";

// Kimi K2.7 Code via the Workers AI binding: no model API key needed.
export const DEFAULT_REVIEW_MODEL = "cloudflare/@cf/moonshotai/kimi-k2.7-code";
export const DEFAULT_GATEWAY_REVIEWERS = [
	"anthropic/claude-opus-5-5",
	"openai/gpt-6.1-sol",
] as const;
export const DEFAULT_MERGE_MODEL = "anthropic/claude-sonnet-5-5";
export const DEFAULT_FOLLOW_UP_REVIEWERS = ["openai/gpt-6.1-sol"] as const;

// Keeps vendor models within the same compaction budget as the default model,
// so model comparisons do not also compare context sizes.
const GATEWAY_MODEL_LIMITS = { contextWindow: 262_144, maxTokens: 64_000 };

export interface ReviewModelEnv {
	readonly REVIEW_MODEL?: string;
	readonly REVIEW_MODELS?: string;
	readonly REVIEW_MERGE_MODEL?: string;
	readonly REVIEW_FOLLOWUP_MODELS?: string;
	readonly AI_GATEWAY_ACCOUNT_ID?: string;
	readonly AI_GATEWAY_NAME?: string;
	readonly AI_GATEWAY_TOKEN?: string;
}

export function reviewModel(env: ReviewModelEnv): string {
	return env.REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
}

export interface ReviewPlan {
	/** Models that each review the PR independently, in order. */
	readonly reviewers: readonly string[];
	/** Tool-less model that merges two or more reviews; absent without the gateway. */
	readonly mergeModel?: string;
}

function hasGateway(env: ReviewModelEnv): boolean {
	return Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_NAME && env.AI_GATEWAY_TOKEN);
}

function modelList(value: string | undefined): string[] {
	const models = (value ?? "")
		.split(",")
		.map((model) => model.trim())
		.filter(Boolean);
	return [...new Set(models)];
}

/**
 * Which models review a PR. Without the gateway, one model reviews as it always
 * has: `REVIEW_MODEL`, or Kimi. With the gateway, a full review uses
 * `REVIEW_MODELS`, then a single `REVIEW_MODEL` (used by the local evaluation),
 * then Opus and Sol; an automatic follow-up uses `REVIEW_FOLLOWUP_MODELS`, then
 * Sol alone.
 */
export function reviewPlan(
	env: ReviewModelEnv,
	options: { readonly followUp?: boolean } = {},
): ReviewPlan {
	if (!hasGateway(env)) return { reviewers: [reviewModel(env)] };
	const mergeModel = env.REVIEW_MERGE_MODEL?.trim() || DEFAULT_MERGE_MODEL;
	if (options.followUp) {
		const followUp = modelList(env.REVIEW_FOLLOWUP_MODELS);
		return {
			reviewers: followUp.length > 0 ? followUp : [...DEFAULT_FOLLOW_UP_REVIEWERS],
			mergeModel,
		};
	}
	const configured = modelList(env.REVIEW_MODELS);
	const reviewers =
		configured.length > 0
			? configured
			: env.REVIEW_MODEL?.trim()
				? [reviewModel(env)]
				: [...DEFAULT_GATEWAY_REVIEWERS];
	return { reviewers, mergeModel };
}

// The bundled catalog predates these models, so Flue would build them as
// zero-metadata, non-reasoning models and the wire protocols would drop the
// agent's thinking level. These wrappers restore the catalog metadata the
// AI Gateway catalog publishes for them before delegating to the stock protocol.
type GatewayProvider = "anthropic" | "openai";

const ANTHROPIC_COMPAT = {
	sendSessionAffinityHeaders: true,
	forceAdaptiveThinking: true,
	supportsTemperature: false,
};

const GATEWAY_MODELS: Record<string, Partial<Model<Api>>> = {
	"claude-opus-5-5": {
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: ANTHROPIC_COMPAT,
	},
	"claude-sonnet-5-5": {
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: ANTHROPIC_COMPAT,
	},
	"gpt-6.1-sol": {
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
};

const GATEWAY_PROTOCOLS: Record<GatewayProvider, { api: Api; streams: () => ProviderStreams }> = {
	anthropic: { api: "anthropic-messages", streams: anthropicMessagesApi },
	openai: { api: "openai-responses", streams: openAIResponsesApi },
};

const GATEWAY_API_PREFIX = "review-gateway:";

function withMetadata(model: Model<Api>, api: Api): Model<Api> {
	return { ...model, ...GATEWAY_MODELS[model.id], api };
}

function registerReasoningApi(provider: GatewayProvider): string {
	const { api, streams: createStreams } = GATEWAY_PROTOCOLS[provider];
	const streams = createStreams();
	const name = `${GATEWAY_API_PREFIX}${provider}`;
	registerApiProvider({
		api: name,
		stream: (model, context, options) => streams.stream(withMetadata(model, api), context, options),
		streamSimple: (model, context, options) =>
			streams.streamSimple(withMetadata(model, api), context, options),
	});
	return name;
}

function gatewayBase(env: ReviewModelEnv): string {
	return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.AI_GATEWAY_ACCOUNT_ID ?? "")}/${encodeURIComponent(env.AI_GATEWAY_NAME ?? "")}`;
}

function gatewayHeaders(env: ReviewModelEnv): Record<string, string> {
	return {
		"cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN ?? ""}`,
		"cf-aig-skip-cache": "true",
	};
}

/**
 * Routes the `anthropic` and `openai` providers through an authenticated AI
 * Gateway with Unified Billing. The gateway accepts its own token in place of
 * a provider key and rejects any real-looking provider key it does not own, so
 * the gateway token is also the provider API key. Returns false, registering
 * nothing, unless all three gateway settings are present.
 */
export function registerGatewayProviders(env: ReviewModelEnv): boolean {
	if (!hasGateway(env)) return false;
	for (const provider of ["anthropic", "openai"] as const) {
		registerProvider(provider, {
			api: registerReasoningApi(provider),
			baseUrl: `${gatewayBase(env)}/${provider}`,
			apiKey: env.AI_GATEWAY_TOKEN,
			headers: gatewayHeaders(env),
			...GATEWAY_MODEL_LIMITS,
		});
	}
	return true;
}

function isGatewayProvider(value: string): value is GatewayProvider {
	return value === "anthropic" || value === "openai";
}

function parseGatewaySpecifier(specifier: string): { provider: GatewayProvider; id: string } {
	const slash = specifier.indexOf("/");
	const provider = specifier.slice(0, slash);
	const id = specifier.slice(slash + 1);
	if (slash <= 0 || !id || !isGatewayProvider(provider)) {
		throw new Error(`${specifier} is not an AI Gateway model`);
	}
	return { provider, id };
}

/** The gateway model for an `anthropic/...` or `openai/...` specifier, outside any Flue session. */
export function gatewayModel(env: ReviewModelEnv, specifier: string): Model<Api> {
	if (!hasGateway(env)) throw new Error("AI Gateway settings are missing");
	const { provider, id } = parseGatewaySpecifier(specifier);
	const { api } = GATEWAY_PROTOCOLS[provider];
	return withMetadata(
		{
			id,
			name: id,
			api,
			provider,
			baseUrl: `${gatewayBase(env)}/${provider}`,
			headers: gatewayHeaders(env),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...GATEWAY_MODEL_LIMITS,
		},
		api,
	);
}

export interface GatewayCompletion {
	readonly text: string;
	readonly usage: Usage;
}

/**
 * One tool-less request to a gateway model. Runs outside Flue's agent loop so
 * the model has no access to the sandbox's tools.
 */
export async function completeWithGateway(
	env: ReviewModelEnv,
	specifier: string,
	prompt: string,
	options: { signal?: AbortSignal; reasoning?: ThinkingLevel } = {},
): Promise<GatewayCompletion> {
	const model = gatewayModel(env, specifier);
	const { streams } = GATEWAY_PROTOCOLS[parseGatewaySpecifier(specifier).provider];
	const message = await streams()
		.streamSimple(
			model,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{
				apiKey: env.AI_GATEWAY_TOKEN,
				signal: options.signal,
				...(options.reasoning ? { reasoning: options.reasoning } : {}),
			},
		)
		.result();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage || `${specifier} request failed`);
	}
	const text = message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");
	return { text, usage: message.usage };
}
