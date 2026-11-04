import { buildLiveSearchResultUrl, type LiveSearchRouteMap } from "./live-search-routing.js";

export interface SiteSearchToolConfig {
	/** Comma-separated collection slugs, or `""` for every searchable collection. */
	collections: string;
	/** Locale to search, or `""` for every locale. */
	locale: string;
	/** Default and maximum number of results per call. */
	limit: number;
	routeMap: LiveSearchRouteMap;
}

interface SiteSearchToolResult {
	title: string;
	url: string;
	collection: string;
	excerpt?: string;
}

interface WebMcpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
	/**
	 * WebMCP serializes the fulfilled value to JSON for the agent and reports only a
	 * rejection as a failed call, so errors must throw rather than resolve.
	 */
	execute: (input: { query?: unknown; limit?: unknown }) => Promise<SiteSearchToolResult[]>;
}

export interface ModelContextLike {
	registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => unknown;
}

export interface WithModelContext {
	modelContext?: ModelContextLike;
}

interface SearchApiResult {
	collection: string;
	id: string;
	slug: string | null;
	title?: string;
	snippet?: string;
}

const MARK_RE = /<\/?mark>/g;
const MAX_LIMIT = 100;

/** Turns a search snippet (escaped text with `<mark>` highlights) into plain text. */
function snippetToText(snippet: string): string {
	return snippet
		.replace(MARK_RE, "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
}

export function createSiteSearchTool(
	config: SiteSearchToolConfig,
	origin: string,
	fetchImpl: typeof fetch = fetch,
): WebMcpTool {
	const maxLimit = Math.min(Math.max(Math.floor(config.limit) || 1, 1), MAX_LIMIT);
	return {
		name: "search_site",
		description:
			"Search this site's published content. Returns matching pages with their title, URL, and a text excerpt.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Words to search for" },
				limit: {
					type: "integer",
					minimum: 1,
					maximum: maxLimit,
					description: `Maximum number of results (default ${maxLimit})`,
				},
			},
			required: ["query"],
		},
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		async execute(input) {
			const query = typeof input.query === "string" ? input.query.trim() : "";
			if (!query) throw new Error("Provide a search query.");
			const requested = typeof input.limit === "number" ? Math.floor(input.limit) : maxLimit;
			const limit = Math.min(Math.max(requested, 1), maxLimit);

			const params = new URLSearchParams({ q: query, limit: String(limit) });
			if (config.collections) params.set("collections", config.collections);
			if (config.locale) params.set("locale", config.locale);

			const response = await fetchImpl(`${origin}/_emdash/api/search?${params}`);
			if (!response.ok) throw new Error(`Search failed (HTTP ${response.status}).`);
			const body: { data?: { items?: SearchApiResult[] } } = await response.json();
			return (body.data?.items ?? []).map((item) => ({
				title: item.title ?? item.slug ?? item.id,
				url: new URL(buildLiveSearchResultUrl(item, config.routeMap), origin).href,
				collection: item.collection,
				...(item.snippet ? { excerpt: snippetToText(item.snippet) } : {}),
			}));
		},
	};
}

function warnRegistrationFailed(error: unknown): void {
	console.warn("[emdash] Could not register the WebMCP search tool:", error);
}

/** Returns the browser's WebMCP model context, preferring `document` over the deprecated `navigator` location. */
export function resolveModelContext(
	doc?: WithModelContext,
	nav?: WithModelContext,
): ModelContextLike | undefined {
	return doc?.modelContext ?? nav?.modelContext;
}

/** Registers the site search tool when the browser supports WebMCP. */
export function registerSiteSearchTool(
	modelContext: ModelContextLike | undefined,
	config: SiteSearchToolConfig,
	origin: string,
	signal?: AbortSignal,
): boolean {
	if (!modelContext) return false;
	try {
		Promise.resolve(
			modelContext.registerTool(createSiteSearchTool(config, origin), { signal }),
		).catch(warnRegistrationFailed);
		return true;
	} catch (error) {
		warnRegistrationFailed(error);
		return false;
	}
}
