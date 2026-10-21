import { z } from "astro/zod";
import type { PluginContext, PluginRoute } from "emdash";
import { definePluginRoute, PluginRouteError, PluginSettingEncryptionError } from "emdash";

import { countBySource, loadActivity } from "./activity.js";
import { getBuild, recentBuildUploads, runBuild, startBuild } from "./build.js";
import {
	type Config,
	configSchema,
	defaultConfig,
	describeSources,
	describeTaxonomies,
	enabledSources,
	loadConfig,
	resultLabels,
	updateConfig,
} from "./config.js";
import { describeConnection, openProvider, saveCredentials } from "./connection.js";
import { openSession } from "./context.js";
import { entryIndexStatus } from "./entry-status.js";
import { listExamples } from "./examples.js";
import { indexImpact } from "./impact.js";
import { emdashAccess } from "./indexer.js";
import { indexTotals } from "./ingestion.js";
import type { AiSearchOptions } from "./options.js";
import { type InstanceInfo, isProviderError, ProviderError } from "./ports/ai-search.js";
import { clearDropped, getRetryQueue, retryRecord } from "./retry.js";
import { searchResponse, tooManySearches } from "./search.js";
import { allowSearch, SEARCH_WINDOW_MS } from "./throttle.js";
import { URL_TEMPLATE } from "./url-template.js";
import { markInstanceCreated } from "./warm-up.js";

const recordSchema = z.object({ source: z.string(), id: z.string() });

const credentialSchema = z.string().trim().min(1).max(256).optional();

/** Keeps each admin request short so the page can show progress between them. */
const STEP_BUDGET_MS = 8_000;

export function createRoutes(options: AiSearchOptions): Record<string, PluginRoute> {
	const requireSession = async (ctx: PluginContext) => {
		const session = await openSession(ctx, options);
		if (!session) {
			throw new PluginRouteError("NOT_CONFIGURED", "AI Search is not set up", 409);
		}
		return session;
	};

	return {
		search: definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 16 * 1024 },
			response: "raw",
			handler: async (ctx) => {
				const session = await openSession(ctx, options);
				// Every REST search spends the API token's rate limit, which builds and the admin share.
				if (session?.provider.kind === "rest" && !allowSearch(ctx.requestMeta.ip)) {
					return tooManySearches(SEARCH_WINDOW_MS / 1000);
				}
				return searchResponse(session, ctx.input);
			},
		}),

		status: {
			permission: "plugins:read",
			handler: async (ctx) => {
				const provider = await openProvider(ctx, options);
				const session = provider ? await openSession(ctx, options, provider) : null;
				const [build, recentUploads, queue] = await Promise.all([
					getBuild(ctx),
					recentBuildUploads(ctx),
					getRetryQueue(ctx),
				]);
				let credentialsRejected = false;
				let rateLimited = false;
				let instanceMissing = false;
				const [stats, listed, counts, info] = session
					? await Promise.all([
							session.provider.stats(),
							session.provider.listItems({ perPage: 1 }),
							// Counts change with every upload; the progress panel replaces them during a build.
							build ? null : countBySource(session.provider, enabledSources(session.config)),
							build ? null : session.provider.info().catch(() => null),
						]).catch(async (error: unknown) => {
							if (isProviderError(error, "unauthorized")) credentialsRejected = true;
							else if (isProviderError(error, "not-found")) instanceMissing = true;
							else if (!isProviderError(error, "rate-limited")) throw error;
							else if (await session.provider.tokenRejected?.()) credentialsRejected = true;
							else rateLimited = true;
							return [null, null, null, null] as const;
						})
					: [null, null, null, null];
				const connected = provider !== null && !credentialsRejected;
				return {
					connected,
					method: connected ? provider.kind : null,
					credentialsRejected,
					rateLimited,
					instanceMissing,
					configured: session !== null,
					build,
					totals: indexTotals({
						stats,
						listedItems: listed?.total ?? 0,
						uploadFailures: queue.items,
						droppedFailures: queue.dropped,
					}),
					retrying: queue.items.some((item) => item.nextAt !== null),
					recentBuild: recentUploads > 0,
					lastActivity: stats?.lastActivity ?? null,
					counts,
					dashboardUrl: info ? dashboardUrl(info) : null,
				};
			},
		},

		config: {
			permission: "search:manage",
			handler: async (ctx) => {
				const [collections, definitions, saved] = await Promise.all([
					ctx.schema?.listCollections() ?? [],
					ctx.taxonomies?.getAll() ?? [],
					loadConfig(ctx),
				]);
				const taxonomies = describeTaxonomies(definitions);
				return {
					config: saved ?? defaultConfig(collections, taxonomies),
					saved: saved !== null,
					sources: describeSources(collections),
					taxonomies,
				};
			},
		},

		examples: route({
			permission: "search:manage",
			input: z.object({
				source: z.string(),
				urlTemplate: z.string().regex(URL_TEMPLATE).optional(),
			}),
			handler: async (ctx) => {
				return {
					examples: await listExamples(emdashAccess(ctx), ctx.input.source, ctx.input.urlTemplate),
				};
			},
		}),

		"config/save": route({
			permission: "search:manage",
			methods: ["POST"],
			input: configSchema,
			handler: async (ctx) => {
				const provider = await openProvider(ctx, options);
				if (!provider) {
					throw new PluginRouteError("NOT_CONNECTED", "AI Search is not connected", 409);
				}
				const { created } = await provider.ensureInstance().catch(rethrowProviderError);
				if (created) await markInstanceCreated(ctx);

				const collections = (await ctx.schema?.listCollections()) ?? [];
				const known = new Set(describeSources(collections).map((info) => info.id));
				const sources = Object.fromEntries(
					Object.entries(ctx.input.sources).filter(([id]) => known.has(id)),
				);
				let previous = null as Config | null;
				const config = await updateConfig(ctx, (current) => {
					previous = current;
					return { ...ctx.input, sources, labels: resultLabels(collections) };
				});
				if (!config) throw new Error("[ai-search] config was not saved");
				await startBuild(
					ctx,
					created
						? enabledSources(config)
						: indexImpact(previous, config).map((impact) => impact.source),
				);
				return config;
			},
		}),

		"index/rebuild": {
			permission: "search:manage",
			methods: ["POST"],
			handler: async (ctx) => {
				const { config } = await requireSession(ctx);
				await startBuild(ctx, enabledSources(config));
				await clearDropped(ctx);
				return getBuild(ctx);
			},
		},

		activity: {
			permission: "plugins:read",
			handler: async (ctx) => {
				const { provider, indexer } = await requireSession(ctx);
				return loadActivity(ctx, provider, indexer);
			},
		},

		"entry/status": route({
			permission: "plugins:read",
			input: recordSchema,
			handler: async (ctx) => {
				const session = await openSession(ctx, options);
				if (!session) return { configured: false as const };
				const queue = await getRetryQueue(ctx);
				return {
					configured: true as const,
					...(await entryIndexStatus(session.indexer, queue, ctx.input)),
				};
			},
		}),

		"entry/sync": route({
			permission: "content:edit_any",
			methods: ["POST"],
			input: recordSchema,
			handler: async (ctx) => {
				const { indexer } = await requireSession(ctx);
				return { outcome: await retryRecord(ctx, indexer, ctx.input) };
			},
		}),

		connection: {
			permission: "search:manage",
			handler: async (ctx) => describeConnection(ctx),
		},

		"connection/save": route({
			permission: "search:manage",
			methods: ["POST"],
			input: z.object({ accountId: credentialSchema, apiToken: credentialSchema }),
			handler: async (ctx) => {
				const config = await loadConfig(ctx);
				let saved = { created: false, accountChanged: false };
				try {
					// Another account may not have the instance yet, or an index out of date.
					saved = await saveCredentials(ctx, options, ctx.input, {
						ensureInstance: config !== null,
					});
				} catch (error) {
					if (
						error instanceof PluginSettingEncryptionError &&
						error.code === "PLUGIN_SETTING_ENCRYPTION_KEY_MISSING"
					) {
						throw new PluginRouteError(
							"ENCRYPTION_KEY_MISSING",
							"Storing a token needs EMDASH_ENCRYPTION_KEY. Set EMDASH_AI_SEARCH_API_TOKEN instead, or configure an encryption key.",
							409,
						);
					}
					rethrowProviderError(error);
				}
				if (saved.created) await markInstanceCreated(ctx);
				if (config && (saved.created || saved.accountChanged)) {
					await startBuild(ctx, enabledSources(config));
				}
				return describeConnection(ctx);
			},
		}),

		"index/step": {
			permission: "search:manage",
			methods: ["POST"],
			handler: async (ctx) => {
				const { indexer, provider } = await requireSession(ctx);
				return { build: await runBuild(ctx, indexer, STEP_BUDGET_MS, provider) };
			},
		},
	};
}

/** Turns an AI Search refusal into an error the admin can show. */
function rethrowProviderError(error: unknown): never {
	if (!(error instanceof ProviderError)) throw error;
	if (error.reason === "unauthorized") {
		throw new PluginRouteError(
			"INVALID_CREDENTIALS",
			"Cloudflare rejected the account ID or API token. The token needs the AI Search Edit and AI Search Run permissions on this account.",
			400,
		);
	}
	if (error.reason === "rate-limited") {
		throw new PluginRouteError(
			"RATE_LIMITED",
			"Cloudflare is limiting requests to AI Search. Try again in a few minutes.",
			429,
		);
	}
	if (error.reason === "not-found") {
		throw new PluginRouteError(
			"NAMESPACE_NOT_FOUND",
			"The AI Search namespace does not exist in this account.",
			400,
		);
	}
	throw new PluginRouteError("AI_SEARCH_UNAVAILABLE", `AI Search reported: ${error.message}`, 502);
}

/** The instance's page in the Cloudflare dashboard, which fills in the account. */
function dashboardUrl(info: InstanceInfo): string {
	const base = "https://dash.cloudflare.com/?to=/:account/ai/ai-search";
	if (!info.namespace) return base;
	return `${base}/namespace/${encodeURIComponent(info.namespace)}/instance/${encodeURIComponent(info.id)}/overview`;
}

/** Infers a route's input type from its schema. */
function route<TInput>(definition: PluginRoute<TInput>): PluginRoute {
	return definition;
}
