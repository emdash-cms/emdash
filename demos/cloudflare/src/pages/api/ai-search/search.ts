export const prerender = false;

import type { APIRoute } from "astro";

/**
 * Search endpoint for the Cloudflare AI Search snippet.
 *
 * The `@cloudflare/ai-search-snippet` web components POST to `{api-url}/search`
 * with a Cloudflare AI Search request body and expect the native AI Search
 * response shape (`{ success, result: { chunks } }`).
 *
 * We query the `AI_SEARCH` binding directly (the same instance the ai-search
 * plugin indexes into) rather than proxying to the plugin's HTTP route: a
 * Worker fetching its own route is a self-subrequest that is unreliable in the
 * Cloudflare runtime. The plugin stores `title`, `slug`, `description` and
 * `image` as item metadata, and keys items as `{collection}/{id}.md`, so we can
 * build public URLs and result cards straight from the search response.
 */

const AI_SEARCH_INSTANCE = "emdash-content";
const DEFAULT_LOCALE = "en-us";
const MD_EXT = /\.md$/;

// Title and description are packed into one metadata field by the ai-search
// plugin (AI Search allows at most 5 custom_metadata fields), joined by the
// ASCII Unit Separator. Keep this in sync with the plugin's TITLE_DESC_SEP.
const TITLE_DESC_SEP = "\u001F";
function unpackTitleDescription(value: string): { title: string; description: string } {
	const i = value.indexOf(TITLE_DESC_SEP);
	if (i < 0) return { title: value, description: "" };
	return { title: value.slice(0, i), description: value.slice(i + 1) };
}

interface SnippetSearchBody {
	messages?: Array<{ role: string; content: string | null }>;
	ai_search_options?: {
		retrieval?: { max_num_results?: number };
	};
	locale?: string;
}

interface AiSearchChunk {
	id: string;
	score: number;
	text?: string;
	item: { key: string; timestamp?: number; metadata?: Record<string, unknown> };
}

interface AiSearchInstance {
	search(params: {
		messages: Array<{ role: string; content: string | null }>;
		ai_search_options?: { retrieval?: Record<string, unknown> };
	}): Promise<{ search_query: string; chunks: AiSearchChunk[] }>;
}

interface AiSearchNamespace {
	get(name: string): AiSearchInstance;
}

/** Resolve the AI_SEARCH namespace binding from the Cloudflare runtime env. */
async function getAiSearch(): Promise<AiSearchNamespace | null> {
	try {
		const { env } = await import("cloudflare:workers");
		const binding = (env as unknown as Record<string, unknown>).AI_SEARCH;
		return binding ? (binding as AiSearchNamespace) : null;
	} catch {
		return null;
	}
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export const POST: APIRoute = async ({ request }) => {
	let body: SnippetSearchBody;
	try {
		body = await request.json();
	} catch {
		return Response.json({ success: false, error: "Invalid request body" }, { status: 400 });
	}

	// The snippet sends the query as the last user message.
	const query = (body.messages ?? []).findLast((m) => m.role === "user")?.content?.trim();
	if (!query) {
		return Response.json({ success: true, result: { chunks: [] } });
	}

	const ns = await getAiSearch();
	if (!ns) {
		return Response.json({ success: false, error: "Search is not available" }, { status: 503 });
	}

	const limit = body.ai_search_options?.retrieval?.max_num_results ?? 30;
	const locale = typeof body.locale === "string" && body.locale ? body.locale : DEFAULT_LOCALE;

	try {
		const instance = ns.get(AI_SEARCH_INSTANCE);
		const nowSeconds = Math.floor(Date.now() / 1000);
		// Built here where `query` is narrowed to string; the nested helper closure
		// would otherwise widen it back to `string | undefined`.
		const messages = [{ role: "user", content: query }];

		async function runSearch(localeCode: string): Promise<AiSearchChunk[]> {
			const response = await instance.search({
				messages,
				ai_search_options: {
					retrieval: {
						max_num_results: limit,
						// The plugin gates scheduled content behind `visible_after`.
						filters: { visible_after: { $lte: nowSeconds }, locale: { $eq: localeCode } },
					},
				},
			});
			return response.chunks;
		}

		let chunks = await runSearch(locale);
		// Fall back to the default locale when the requested locale has no matches.
		if (chunks.length === 0 && locale !== DEFAULT_LOCALE) {
			chunks = await runSearch(DEFAULT_LOCALE);
		}

		// Keep the highest-scoring chunk per indexed item.
		const bestByKey = new Map<string, AiSearchChunk>();
		for (const chunk of chunks) {
			const existing = bestByKey.get(chunk.item.key);
			if (!existing || chunk.score > existing.score) {
				bestByKey.set(chunk.item.key, chunk);
			}
		}

		const resultChunks = Array.from(bestByKey.values(), (chunk) => {
			const [collection = "", ...rest] = chunk.item.key.split("/");
			const id = rest.join("/").replace(MD_EXT, "");
			const meta = chunk.item.metadata ?? {};
			const slug = str(meta.slug) || id;
			const { title, description } = unpackTitleDescription(str(meta.title_desc));
			const text = chunk.text?.trim();
			return {
				id: chunk.item.key,
				score: chunk.score,
				item: {
					key: `/${collection}/${slug}?lang=${encodeURIComponent(locale)}`,
					metadata: {
						title: title || slug,
						description: text || description,
						...(str(meta.image) ? { image: str(meta.image) } : {}),
					},
				},
			};
		});

		return Response.json({ success: true, result: { chunks: resultChunks } });
	} catch {
		return Response.json(
			{ success: false, error: "Search is temporarily unavailable" },
			{ status: 500 },
		);
	}
};
