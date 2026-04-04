/**
 * AI service types for EmDash.
 *
 * BYOK (Bring Your Own Key) model: users configure their own API key
 * in Settings > AI. All AI features are hidden when no key is configured.
 */

export interface AiConfig {
	provider: "openai" | "anthropic" | "openai-compatible";
	apiKey: string;
	/** Base URL for OpenAI-compatible providers (Ollama, Together, Groq, etc.) */
	baseUrl?: string;
	/** Model to use. Defaults to provider's best model. */
	model?: string;
}

export interface AiCompletionRequest {
	/** The text prompt or messages to send */
	prompt: string;
	/** System instructions */
	system?: string;
	/** Maximum tokens in response */
	maxTokens?: number;
	/** Temperature (0-2). Lower = more focused. */
	temperature?: number;
	/** Number of completions to generate */
	n?: number;
}

export interface AiCompletionResponse {
	choices: Array<{
		text: string;
		index: number;
	}>;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}

export interface AiRewriteRequest {
	/** The text to rewrite */
	text: string;
	/** Number of alternatives to generate (default: 3) */
	count?: number;
	/** Style hint: "formal" | "casual" | "concise" | "expanded" */
	style?: string;
}

export interface AiRewriteResponse {
	alternatives: string[];
}

export type AiErrorCode =
	| "AI_NOT_CONFIGURED"
	| "AI_TIMEOUT"
	| "AI_RATE_LIMITED"
	| "AI_EMPTY_RESPONSE"
	| "AI_PARSE_ERROR"
	| "AI_CONTENT_POLICY"
	| "AI_INVALID_KEY"
	| "AI_PROVIDER_ERROR";

export class AiError extends Error {
	constructor(
		public readonly code: AiErrorCode,
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "AiError";
	}
}
