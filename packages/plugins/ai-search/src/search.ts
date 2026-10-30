import { z } from "astro/zod";
import { pluginResponse } from "emdash";

import type { Config } from "./config.js";
import { readMetadata } from "./documents.js";
import type { AiSearchProvider, SearchChunk } from "./ports/ai-search.js";

/** AI Search returns at most 50 chunks; several chunks can belong to one document. */
const MAX_CHUNKS = 50;
const DEFAULT_LIMIT = 10;

/**
 * Request body sent by `<search-modal-snippet>`, plus the `locale` that the
 * Astro component adds through the snippet's `request-options`.
 */
const snippetRequestSchema = z.object({
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
	locale: z.string().optional(),
	ai_search_options: z
		.object({
			retrieval: z.object({ max_num_results: z.number().optional() }).optional(),
		})
		.optional(),
});

export interface SearchInput {
	query: string;
	locale?: string;
	limit: number;
}

interface SearchHit {
	source: string;
	title: string;
	url: string;
	excerpt: string;
	image?: string;
}

export interface SearchSession {
	config: Config;
	provider: Pick<AiSearchProvider, "search">;
}

export function parseSearchRequest(body: unknown): SearchInput | null {
	const parsed = snippetRequestSchema.safeParse(body);
	if (!parsed.success) return null;
	const query = parsed.data.messages.findLast((message) => message.role === "user")?.content.trim();
	if (!query) return null;
	const requested = parsed.data.ai_search_options?.retrieval?.max_num_results ?? DEFAULT_LIMIT;
	return {
		query,
		...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
		limit: Math.min(Math.max(Math.trunc(requested), 1), MAX_CHUNKS),
	};
}

/**
 * Answers the AI Search snippet's `POST {api-url}/search` in the shape of the
 * AI Search REST API.
 */
export async function searchResponse(session: SearchSession | null, body: unknown) {
	const input = parseSearchRequest(body);
	if (!input) {
		return json(400, {
			success: false,
			error: { code: "INVALID_QUERY", message: "Enter a search" },
		});
	}
	if (!session) {
		return json(503, {
			success: false,
			error: { code: "NOT_CONFIGURED", message: "Search is not set up" },
		});
	}

	const enabled = (source: string) => session.config.sources[source]?.enabled === true;
	let hits: SearchHit[];
	try {
		hits = await searchIndex(session.provider, input, enabled);
	} catch (error) {
		console.error("[ai-search] search failed:", error);
		return json(503, {
			success: false,
			error: { code: "SEARCH_UNAVAILABLE", message: "Search is temporarily unavailable" },
		});
	}
	const labels = session.config.labels ?? {};

	return json(200, {
		success: true,
		result: {
			search_query: input.query,
			chunks: hits.map((hit) => ({
				id: hit.url,
				type: "text",
				text: hit.excerpt,
				item: {
					key: hit.url,
					metadata: {
						title: escapeHtml(hit.title),
						description: escapeHtml(hit.excerpt),
						group: labels[hit.source] ?? hit.source,
						...(hit.image ? { image: hit.image } : {}),
					},
				},
			})),
		},
	});
}

/** The search box reads titles and descriptions as HTML and shows their text. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The answer to a visitor who searched too often, without asking AI Search. */
export function tooManySearches(retryAfterSeconds: number) {
	return json(
		429,
		{
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many searches. Try again soon." },
		},
		{ "retry-after": String(retryAfterSeconds) },
	);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
	return pluginResponse({
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
		body: { kind: "text", value: JSON.stringify(body) },
	});
}

export async function searchIndex(
	provider: Pick<AiSearchProvider, "search">,
	input: SearchInput,
	includeSource: (source: string) => boolean,
): Promise<SearchHit[]> {
	const chunks = await provider.search({
		query: input.query,
		maxResults: MAX_CHUNKS,
		...(input.locale ? { filters: { locale: input.locale } } : {}),
		boostBy: "priority",
	});
	return bestChunkPerDocument(chunks)
		.filter((hit) => includeSource(hit.source))
		.slice(0, input.limit);
}

/** Chunks arrive ranked, priority boost included, so a document's first chunk is its best. */
function bestChunkPerDocument(chunks: SearchChunk[]): SearchHit[] {
	const byKey = new Map<string, SearchHit>();
	for (const chunk of chunks) {
		const metadata = byKey.has(chunk.key) ? null : readMetadata(chunk.metadata);
		if (!metadata) continue;
		const { source, title, url, excerpt, image } = metadata;
		byKey.set(chunk.key, { source, title, url, excerpt, ...(image ? { image } : {}) });
	}
	return [...byKey.values()];
}
