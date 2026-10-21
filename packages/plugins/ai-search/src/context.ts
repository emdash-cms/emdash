import type { PluginContext } from "emdash";

import { getInstance } from "./binding.js";
import { type Config, loadConfig } from "./config.js";
import { Indexer } from "./indexer.js";
import type { AiSearchOptions } from "./options.js";

interface Session {
	config: Config;
	instance: AiSearchInstance;
	indexer: Indexer;
}

/**
 * Loads what every indexing operation needs. Returns null until the plugin has
 * been set up, or when the site is not running on Cloudflare Workers.
 */
export async function openSession(
	ctx: PluginContext,
	options: AiSearchOptions,
): Promise<Session | null> {
	const config = await loadConfig(ctx);
	const instance = config ? await getInstance(options) : null;
	if (!config || !instance) return null;
	return { config, instance, indexer: Indexer.fromContext(ctx, instance, config) };
}
