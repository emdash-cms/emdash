/**
 * AI API client functions
 */

import { API_BASE, apiFetch, throwResponseError } from "./client.js";

export interface AiRewriteResult {
	alternatives: string[];
}

export type AiWritingMode = "rewrite" | "expand" | "summarize" | "formal" | "casual" | "translate";

/**
 * Transform text using AI. Returns N alternative versions.
 * Throws if AI is not configured or the request fails.
 */
export async function rewriteText(
	text: string,
	options?: { count?: number; style?: string; mode?: AiWritingMode; targetLanguage?: string },
): Promise<AiRewriteResult> {
	const response = await apiFetch(`${API_BASE}/ai/rewrite`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			text,
			count: options?.count,
			style: options?.style,
			mode: options?.mode,
			targetLanguage: options?.targetLanguage,
		}),
	});

	if (!response.ok) {
		await throwResponseError(response, "AI rewrite failed");
	}

	const body = (await response.json()) as { data: AiRewriteResult };
	return body.data;
}

/**
 * Check if AI is configured (has an API key).
 * Returns true/false without throwing.
 */
export async function isAiConfigured(): Promise<boolean> {
	try {
		const response = await apiFetch(`${API_BASE}/ai/status`);
		if (!response.ok) return false;
		const body = (await response.json()) as { data: { configured: boolean } };
		return body.data.configured;
	} catch {
		return false;
	}
}
