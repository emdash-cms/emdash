import { registerProvider } from "@flue/runtime";

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
		api: "anthropic-messages",
		baseUrl: `${base}/anthropic`,
		apiKey: token,
		headers,
		models: { "claude-opus-5-5": GATEWAY_MODEL_LIMITS },
	});
	registerProvider("openai", {
		api: "openai-responses",
		baseUrl: `${base}/openai`,
		apiKey: token,
		headers,
		models: { "gpt-6.1-sol": GATEWAY_MODEL_LIMITS },
		// The catalog does not know this model, so it is treated as non-reasoning
		// and its reasoning items carry no encrypted content. Replaying them by id
		// across tool turns needs the response stored server-side.
		storeResponses: true,
	});
	return true;
}
