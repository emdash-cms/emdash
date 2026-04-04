/**
 * AI service for EmDash.
 *
 * Shared abstraction used by: editor rewrite, AI writing assistant,
 * NL command palette (Phase 3), content strategy plugin (Phase 3),
 * and any plugin with the ai:complete capability.
 *
 * Provider support:
 * - OpenAI (GPT-4o, GPT-4o-mini, etc.)
 * - Anthropic (Claude)
 * - Any OpenAI-compatible API (Ollama, Together, Groq, etc.)
 */

import type {
	AiCompletionRequest,
	AiCompletionResponse,
	AiConfig,
	AiRewriteRequest,
	AiRewriteResponse,
} from "./types.js";
import { AiError } from "./types.js";

const CODE_BLOCK_START = /^```(?:json)?\n?/;
const CODE_BLOCK_END = /\n?```$/;

const DEFAULT_TIMEOUT = 15_000; // 15 seconds
const REWRITE_TIMEOUT = 10_000; // 10 seconds for rewrite

export class AiService {
	private config: AiConfig | null = null;

	configure(config: AiConfig): void {
		this.config = config;
	}

	isConfigured(): boolean {
		return this.config !== null && this.config.apiKey.length > 0;
	}

	/**
	 * General-purpose text completion.
	 */
	async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
		if (!this.config) {
			throw new AiError(
				"AI_NOT_CONFIGURED",
				"AI is not configured. Add your API key in Settings > AI.",
			);
		}

		const { provider } = this.config;

		if (provider === "anthropic") {
			return this.completeAnthropic(request);
		}

		// OpenAI and OpenAI-compatible use the same API
		return this.completeOpenAI(request);
	}

	/**
	 * Transform text using AI writing assistant.
	 * Supports: rewrite, expand, summarize, formal, casual, translate.
	 */
	async rewrite(request: AiRewriteRequest): Promise<AiRewriteResponse> {
		const mode = request.mode ?? "rewrite";
		const count = request.count ?? (mode === "rewrite" ? 3 : 1);

		const system = buildWritingPrompt(mode, count, request.targetLanguage);

		const response = await this.complete({
			prompt: request.text,
			system,
			maxTokens: 1024,
			temperature: 0.8,
		});

		const raw = response.choices[0]?.text?.trim();
		if (!raw) {
			throw new AiError("AI_EMPTY_RESPONSE", "No suggestions generated. Try different text.");
		}

		try {
			// Extract JSON array from response (handle markdown code blocks)
			const jsonStr = raw.replace(CODE_BLOCK_START, "").replace(CODE_BLOCK_END, "");
			const alternatives = JSON.parse(jsonStr) as string[];

			if (!Array.isArray(alternatives) || alternatives.length === 0) {
				throw new AiError("AI_PARSE_ERROR", "Could not parse AI response into alternatives.");
			}

			return { alternatives: alternatives.slice(0, count) };
		} catch (e) {
			if (e instanceof AiError) throw e;
			throw new AiError("AI_PARSE_ERROR", "Could not parse AI response.", e);
		}
	}

	private async completeOpenAI(request: AiCompletionRequest): Promise<AiCompletionResponse> {
		const config = this.config!;
		const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
		const model = config.model ?? "gpt-4o-mini";

		const messages: Array<{ role: string; content: string }> = [];
		if (request.system) {
			messages.push({ role: "system", content: request.system });
		}
		messages.push({ role: "user", content: request.prompt });

		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			request.maxTokens ? DEFAULT_TIMEOUT : REWRITE_TIMEOUT,
		);

		try {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({
					model,
					messages,
					max_tokens: request.maxTokens ?? 512,
					temperature: request.temperature ?? 0.7,
					n: request.n ?? 1,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (response.status === 429) {
				throw new AiError("AI_RATE_LIMITED", "Rate limited. Try again in a few seconds.");
			}

			if (response.status === 401) {
				throw new AiError("AI_INVALID_KEY", "Invalid API key. Check Settings > AI.");
			}

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new AiError(
					"AI_PROVIDER_ERROR",
					`AI provider error (${response.status}): ${body.slice(0, 200)}`,
				);
			}

			const data = (await response.json()) as {
				choices: Array<{ message: { content: string }; index: number }>;
				usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
			};

			return {
				choices: data.choices.map((c) => ({
					text: c.message.content,
					index: c.index,
				})),
				usage: data.usage
					? {
							promptTokens: data.usage.prompt_tokens,
							completionTokens: data.usage.completion_tokens,
							totalTokens: data.usage.total_tokens,
						}
					: undefined,
			};
		} catch (e) {
			clearTimeout(timeout);
			if (e instanceof AiError) throw e;
			if (e instanceof DOMException && e.name === "AbortError") {
				throw new AiError("AI_TIMEOUT", "AI is taking too long. Try again?");
			}
			throw new AiError("AI_PROVIDER_ERROR", "Failed to connect to AI provider.", e);
		}
	}

	private async completeAnthropic(request: AiCompletionRequest): Promise<AiCompletionResponse> {
		const config = this.config!;
		const model = config.model ?? "claude-sonnet-4-6";

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

		try {
			const response = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": config.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model,
					max_tokens: request.maxTokens ?? 512,
					system: request.system,
					messages: [{ role: "user", content: request.prompt }],
				}),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (response.status === 429) {
				throw new AiError("AI_RATE_LIMITED", "Rate limited. Try again in a few seconds.");
			}

			if (response.status === 401) {
				throw new AiError("AI_INVALID_KEY", "Invalid API key. Check Settings > AI.");
			}

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new AiError(
					"AI_PROVIDER_ERROR",
					`AI provider error (${response.status}): ${body.slice(0, 200)}`,
				);
			}

			const data = (await response.json()) as {
				content: Array<{ type: string; text: string }>;
				usage?: { input_tokens: number; output_tokens: number };
			};

			const text = data.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");

			return {
				choices: [{ text, index: 0 }],
				usage: data.usage
					? {
							promptTokens: data.usage.input_tokens,
							completionTokens: data.usage.output_tokens,
							totalTokens: data.usage.input_tokens + data.usage.output_tokens,
						}
					: undefined,
			};
		} catch (e) {
			clearTimeout(timeout);
			if (e instanceof AiError) throw e;
			if (e instanceof DOMException && e.name === "AbortError") {
				throw new AiError("AI_TIMEOUT", "AI is taking too long. Try again?");
			}
			throw new AiError("AI_PROVIDER_ERROR", "Failed to connect to AI provider.", e);
		}
	}
}

/**
 * Build the system prompt for each writing mode.
 */
function buildWritingPrompt(
	mode: import("./types.js").AiWritingMode,
	count: number,
	targetLanguage?: string,
): string {
	const jsonInstruction = `Return ONLY a JSON array of ${count} string${count > 1 ? "s" : ""}, no other text. Example: ${count > 1 ? '["version 1", "version 2"]' : '["result"]'}`;

	switch (mode) {
		case "rewrite":
			return `You are a writing assistant. Rewrite the given text ${count} different ways. Each version should have a different tone or approach (e.g., more concise, more formal, more conversational). ${jsonInstruction}`;

		case "expand":
			return `You are a writing assistant. Expand the given text to be more detailed and comprehensive. Add supporting details, examples, or elaboration while maintaining the original meaning and voice. ${jsonInstruction}`;

		case "summarize":
			return `You are a writing assistant. Summarize the given text to be shorter and more concise. Preserve the key points and meaning but remove redundancy. Aim for about 50% of the original length. ${jsonInstruction}`;

		case "formal":
			return `You are a writing assistant. Rewrite the given text in a more formal, professional tone. Use precise language, avoid contractions, and maintain a polished register. ${jsonInstruction}`;

		case "casual":
			return `You are a writing assistant. Rewrite the given text in a more casual, conversational tone. Use natural language, contractions where appropriate, and a friendly register. ${jsonInstruction}`;

		case "translate":
			return `You are a translator. Translate the given text to ${targetLanguage || "English"}. Preserve the original meaning, tone, and formatting as closely as possible. ${jsonInstruction}`;

		default:
			return `You are a writing assistant. Rewrite the given text ${count} different ways. ${jsonInstruction}`;
	}
}
