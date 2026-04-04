/**
 * AI API client
 *
 * Provides natural language parsing for the command palette.
 */

import { apiFetch, API_BASE } from "./client.js";

export interface ParsedCommand {
	action: "navigate" | "search" | "create";
	target: string;
	params?: Record<string, unknown>;
}

const SYSTEM_PROMPT = `Parse this natural language query into a CMS admin action. Return a JSON object with: { action: 'navigate' | 'search' | 'create', target: string, params?: object }. Examples: 'show me all draft posts' -> { "action": "search", "target": "posts", "params": { "status": "draft" } }. 'create a new blog post about TypeScript' -> { "action": "create", "target": "posts", "params": { "title": "TypeScript" } }. Return ONLY the JSON object, no other text.`;

/**
 * Send a natural language query to the AI service for parsing into
 * a structured CMS command. Returns null if AI is not configured
 * or the request fails.
 */
export async function parseNaturalLanguageCommand(query: string): Promise<ParsedCommand | null> {
	try {
		const response = await apiFetch(`${API_BASE}/ai/rewrite`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "rewrite",
				text: query,
				systemPrompt: SYSTEM_PROMPT,
			}),
		});

		if (!response.ok) return null;

		const body = (await response.json()) as { data?: { text?: string } };
		const text = body.data?.text;
		if (!text) return null;

		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "action" in parsed && "target" in parsed) {
			return parsed as ParsedCommand;
		}
		return null;
	} catch {
		return null;
	}
}
