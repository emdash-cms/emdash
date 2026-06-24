// Flue application entry. Its top-level code runs at startup for both
// `flue run` (CLI / GitHub Actions) and `flue dev` (evals), which is where
// provider registration belongs.
//
// Why this exists: pi-ai's built-in `cloudflare-ai-gateway` catalog is a stale
// snapshot (kimi capped at k2.6, no glm-5.2), and the built-in
// `cloudflare-workers-ai` provider is binding-based, so it only works inside a
// Worker. This bot runs on Node. The AI Gateway's OpenAI-compatible `/compat`
// endpoint is plain HTTP and serves the *current* Workers AI catalog, so we
// register it here as the `cf-wai` provider. Models are addressed as
// `cf-wai/@cf/<vendor>/<model>` and stay within the Workers-AI-only dev gateway.
// Sweep models in evals by setting FLUE_CLASSIFIER_MODEL / FLUE_FIX_MODEL.

import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const gateway = process.env.CLOUDFLARE_GATEWAY_ID;

if (account && gateway) {
	registerProvider("cf-wai", {
		api: "openai-completions",
		baseUrl: `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/compat`,
		// Falls back to pi-ai's CLOUDFLARE_API_KEY env lookup when unset.
		apiKey: process.env.CLOUDFLARE_API_KEY,
		// Current Workers AI catalog (Jun 2026). The gateway /compat endpoint
		// keys models as `<upstream-provider>/<model>`, so the id carries the
		// `workers-ai/` prefix (matching how pi-ai's own catalog ids them).
		// contextWindow/maxTokens are budgeting hints; override per model.
		models: {
			"workers-ai/@cf/moonshotai/kimi-k2.7-code": { contextWindow: 262_144, maxTokens: 16_384 },
			"workers-ai/@cf/moonshotai/kimi-k2.6": { contextWindow: 262_144, maxTokens: 16_384 },
			"workers-ai/@cf/zai-org/glm-5.2": { contextWindow: 262_144, maxTokens: 16_384 },
			"workers-ai/@cf/zai-org/glm-4.7-flash": { contextWindow: 131_072, maxTokens: 8_192 },
			"workers-ai/@cf/nvidia/nemotron-3-120b-a12b": { contextWindow: 256_000, maxTokens: 8_192 },
			"workers-ai/@cf/openai/gpt-oss-120b": { contextWindow: 128_000, maxTokens: 8_192 },
			"workers-ai/@cf/openai/gpt-oss-20b": { contextWindow: 128_000, maxTokens: 8_192 },
			"workers-ai/@cf/google/gemma-4-26b-a4b-it": { contextWindow: 256_000, maxTokens: 8_192 },
			"workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct": { contextWindow: 128_000, maxTokens: 8_192 },
			"workers-ai/@cf/qwen/qwen3-30b-a3b-fp8": { contextWindow: 32_768, maxTokens: 8_192 },
			"workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct": { contextWindow: 131_000, maxTokens: 8_192 },
			"workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": { contextWindow: 24_000, maxTokens: 8_192 },
			"workers-ai/@cf/ibm-granite/granite-4.0-h-micro": { contextWindow: 131_000, maxTokens: 8_192 },
		},
	});
}

export default flue();
