/**
 * REST-backed `AiBinding` (plan W8.6). Satisfies the code and image adapters'
 * injected-binding interface by POSTing to Workers AI's REST run endpoint,
 * mimicking `env.AI.run`: the REST envelope is `{ result, success, errors }`
 * and `env.AI.run` returns just `result`, so `run` returns `json.result`
 * verbatim. No shape massaging — the production adapters' `parseModelOutput`
 * handles both the OpenAI-compatible `{ choices[0].message.content }` envelope
 * these models return and the classic `{ response }` shape, so the harness
 * exercises the real parse path exactly as production would.
 *
 * The bearer token is read once at construction and never logged or persisted.
 * A per-call diagnostics callback surfaces finish reason, token usage, and the
 * shape of the raw `result` so truncation and envelope drift stay diagnosable.
 */

import type { AiBinding, AiRunInputs } from "../src/code-ai-adapter.js";
import type { ImageAiBinding, ImageAiRunInputs } from "../src/image-ai-adapter.js";

export interface CallDiagnostics {
	readonly modelId: string;
	readonly latencyMs: number;
	readonly httpStatus: number;
	readonly success: boolean;
	readonly finishReason: string | null;
	readonly usage: unknown;
	readonly resultKeys: readonly string[];
	readonly contentLength: number | null;
	readonly reasoningLength: number | null;
}

export interface RestAiBindingOptions {
	readonly accountId: string;
	readonly apiToken: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly onCall?: (diagnostics: CallDiagnostics) => void;
	/** Aborts a call that runs longer than this so one hung model can't stall
	 * the whole sweep; the abort is caught by the adapter as a transient error. */
	readonly timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 120_000;

export class RestAiBinding implements AiBinding, ImageAiBinding {
	readonly #accountId: string;
	readonly #apiToken: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #onCall: ((diagnostics: CallDiagnostics) => void) | undefined;
	readonly #timeoutMs: number;

	constructor(options: RestAiBindingOptions) {
		if (options.accountId.trim().length === 0)
			throw new TypeError("RestAiBinding: accountId must be a non-empty string");
		if (options.apiToken.trim().length === 0)
			throw new TypeError("RestAiBinding: apiToken must be a non-empty string");
		this.#accountId = options.accountId;
		this.#apiToken = options.apiToken;
		this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#onCall = options.onCall;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async run(model: string, inputs: AiRunInputs | ImageAiRunInputs): Promise<unknown> {
		const url = `${this.#baseUrl}/accounts/${this.#accountId}/ai/run/${model}`;
		const started = Date.now();
		const response = await this.#fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(inputs),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		const latencyMs = Date.now() - started;
		const json: unknown = await response.json();
		const result = isRecord(json) ? json.result : undefined;
		const success = isRecord(json) && json.success === true;

		this.#onCall?.(diagnose(model, latencyMs, response.status, success, result));

		if (!response.ok || !success) {
			const errors = isRecord(json) ? json.errors : undefined;
			throw new Error(
				`Workers AI run failed for ${model} (HTTP ${response.status}): ${JSON.stringify(errors ?? json)}`,
			);
		}
		return result;
	}
}

function diagnose(
	modelId: string,
	latencyMs: number,
	httpStatus: number,
	success: boolean,
	result: unknown,
): CallDiagnostics {
	const firstChoice =
		isRecord(result) && Array.isArray(result.choices) ? result.choices[0] : undefined;
	const message = isRecord(firstChoice) ? firstChoice.message : undefined;
	const content = isRecord(message) && typeof message.content === "string" ? message.content : null;
	const reasoning =
		isRecord(message) && typeof message.reasoning_content === "string"
			? message.reasoning_content
			: null;
	return {
		modelId,
		latencyMs,
		httpStatus,
		success,
		finishReason:
			isRecord(firstChoice) && typeof firstChoice.finish_reason === "string"
				? firstChoice.finish_reason
				: null,
		usage: isRecord(result) ? (result.usage ?? null) : null,
		resultKeys: isRecord(result) ? Object.keys(result) : [],
		contentLength: content === null ? null : content.length,
		reasoningLength: reasoning === null ? null : reasoning.length,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
