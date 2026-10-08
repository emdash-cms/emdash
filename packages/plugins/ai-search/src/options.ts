export interface AiSearchOptions {
	/** Name of the `ai_search_namespaces` binding in the Wrangler config. */
	binding: string;
	/** AI Search instance the plugin creates and owns inside that namespace. */
	instance: string;
}

export function resolveOptions(options: Partial<AiSearchOptions> = {}): AiSearchOptions {
	return {
		binding: options.binding ?? "AI_SEARCH",
		instance: options.instance ?? "emdash",
	};
}
