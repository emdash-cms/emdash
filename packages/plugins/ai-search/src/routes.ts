import { z } from "astro/zod";
import type { PluginContext, PluginRoute } from "emdash";
import { definePluginRoute, PluginRouteError } from "emdash";

import { countBySource, loadActivity } from "./activity.js";
import { ensureInstance, getNamespace } from "./binding.js";
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
import { openSession } from "./context.js";
import { entryIndexStatus } from "./entry-status.js";
import { listExamples } from "./examples.js";
import { indexImpact } from "./impact.js";
import { emdashAccess } from "./indexer.js";
import { indexTotals } from "./ingestion.js";
import type { AiSearchOptions } from "./options.js";
import { clearDropped, getRetryQueue, retryRecord } from "./retry.js";
import { searchResponse } from "./search.js";
import { URL_TEMPLATE } from "./url-template.js";
import { markInstanceCreated } from "./warm-up.js";

const recordSchema = z.object({ source: z.string(), id: z.string() });

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
			handler: async (ctx) => searchResponse(await openSession(ctx, options), ctx.input),
		}),

		status: {
			permission: "plugins:read",
			handler: async (ctx) => {
				const connected = (await getNamespace(options)) !== null;
				const session = connected ? await openSession(ctx, options) : null;
				const [build, recentUploads, queue] = await Promise.all([
					getBuild(ctx),
					recentBuildUploads(ctx),
					getRetryQueue(ctx),
				]);
				const [stats, listed, counts, info] = session
					? await Promise.all([
							session.instance.stats(),
							session.instance.items.list({ per_page: 1 }),
							// Counts change with every upload; the progress panel replaces them during a build.
							build ? null : countBySource(session.instance.items, enabledSources(session.config)),
							build ? null : session.instance.info().catch(() => null),
						])
					: [null, null, null, null];
				return {
					connected,
					configured: session !== null,
					build,
					totals: indexTotals({
						stats,
						listedItems: listed?.result_info?.total_count ?? 0,
						uploadFailures: queue.items,
						droppedFailures: queue.dropped,
					}),
					retrying: queue.items.some((item) => item.nextAt !== null),
					recentBuild: recentUploads > 0,
					lastActivity: stats?.last_activity ?? null,
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
				const namespace = await getNamespace(options);
				if (!namespace) {
					throw new PluginRouteError("NO_BINDING", "The AI Search binding is not available", 409);
				}
				const { created } = await ensureInstance(namespace, options);
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
					indexImpact(previous, config).map((impact) => impact.source),
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
				const { instance, indexer } = await requireSession(ctx);
				return loadActivity(ctx, instance.items, indexer);
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

		"index/step": {
			permission: "search:manage",
			methods: ["POST"],
			handler: async (ctx) => {
				const { indexer } = await requireSession(ctx);
				return { build: await runBuild(ctx, indexer, STEP_BUDGET_MS) };
			},
		},
	};
}

/** The instance's page in the Cloudflare dashboard, which fills in the account. */
function dashboardUrl(info: AiSearchInstanceInfo): string {
	const base = "https://dash.cloudflare.com/?to=/:account/ai/ai-search";
	if (!info.namespace) return base;
	return `${base}/namespace/${encodeURIComponent(info.namespace)}/instance/${encodeURIComponent(info.id)}/overview`;
}

/** Infers a route's input type from its schema. */
function route<TInput>(definition: PluginRoute<TInput>): PluginRoute {
	return definition;
}
