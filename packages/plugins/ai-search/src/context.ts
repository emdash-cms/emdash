import type { PluginContext } from "emdash";

import { type Config, loadConfig } from "./config.js";
import { openProvider } from "./connection.js";
import { Indexer } from "./indexer.js";
import type { AiSearchOptions } from "./options.js";
import type { AiSearchProvider } from "./ports/ai-search.js";

interface Session {
	config: Config;
	provider: AiSearchProvider;
	indexer: Indexer;
}

/**
 * Loads what every indexing operation needs. Returns null until the plugin has
 * been set up, or when it cannot reach AI Search.
 */
export async function openSession(
	ctx: PluginContext,
	options: AiSearchOptions,
	connected?: AiSearchProvider,
): Promise<Session | null> {
	const config = await loadConfig(ctx);
	const provider = config ? (connected ?? (await openProvider(ctx, options))) : null;
	if (!config || !provider) return null;
	return { config, provider, indexer: Indexer.fromContext(ctx, provider, config) };
}
