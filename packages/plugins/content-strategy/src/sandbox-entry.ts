/**
 * Sandbox Entry Point -- Content Strategy
 *
 * Canonical plugin implementation using the standard format.
 * Runs in both trusted (in-process) and sandboxed (isolate) modes.
 */

import { definePlugin } from "emdash";
import type { ContentItem, PluginContext } from "emdash";

// ── Constants ──

const STALE_THRESHOLD_DAYS = 90;
const MIN_COLLECTION_POSTS = 5;
const MS_PER_DAY = 86_400_000;

// ── Types ──

interface ContentSaveEvent {
	content: Record<string, unknown>;
	collection: string;
	isNew: boolean;
}

interface CollectionAnalysis {
	collection: string;
	totalPosts: number;
	missingSeoMetadata: ContentItem[];
	stalePosts: ContentItem[];
}

interface AnalysisReport {
	timestamp: string;
	collections: CollectionAnalysis[];
	recommendations: string[];
	summary: {
		totalContent: number;
		totalMissingSeo: number;
		totalStale: number;
		underservedCollections: string[];
	};
}

// ── Helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStale(item: ContentItem, now: number): boolean {
	const updatedAt = new Date(item.updatedAt).getTime();
	return now - updatedAt > STALE_THRESHOLD_DAYS * MS_PER_DAY;
}

function isMissingSeoMetadata(item: ContentItem): boolean {
	const data = item.data;
	const hasMetaTitle = typeof data.meta_title === "string" && data.meta_title.length > 0;
	const hasMetaDescription =
		typeof data.meta_description === "string" && data.meta_description.length > 0;
	const hasSeoTitle = typeof data.seo_title === "string" && data.seo_title.length > 0;
	const hasSeoDescription =
		typeof data.seo_description === "string" && data.seo_description.length > 0;
	return !hasMetaTitle && !hasSeoTitle && !hasMetaDescription && !hasSeoDescription;
}

async function fetchAllContent(
	content: NonNullable<PluginContext["content"]>,
	collection: string,
): Promise<ContentItem[]> {
	const items: ContentItem[] = [];
	let cursor: string | undefined;

	for (;;) {
		const page = await content.list(collection, { limit: 100, cursor });
		items.push(...page.items);
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}

	return items;
}

function buildRecommendations(collections: CollectionAnalysis[]): string[] {
	const recommendations: string[] = [];

	for (const col of collections) {
		if (col.missingSeoMetadata.length > 0) {
			recommendations.push(
				`${col.collection}: ${col.missingSeoMetadata.length} post(s) missing SEO metadata -- add meta titles and descriptions to improve search visibility.`,
			);
		}

		if (col.stalePosts.length > 0) {
			recommendations.push(
				`${col.collection}: ${col.stalePosts.length} post(s) not updated in ${STALE_THRESHOLD_DAYS}+ days -- review for accuracy and freshness.`,
			);
		}

		if (col.totalPosts < MIN_COLLECTION_POSTS) {
			recommendations.push(
				`${col.collection}: only ${col.totalPosts} post(s) -- aim for at least ${MIN_COLLECTION_POSTS} to establish topic authority.`,
			);
		}
	}

	if (recommendations.length === 0) {
		recommendations.push("Content health looks good across all collections. Keep it up!");
	}

	return recommendations;
}

// ── Plugin definition ──

export default definePlugin({
	hooks: {
		"content:afterSave": {
			priority: 200,
			errorPolicy: "continue",
			handler: async (event: ContentSaveEvent, ctx: PluginContext) => {
				const analysisEnabled = await ctx.kv.get<boolean>("settings:analysisEnabled");
				if (analysisEnabled === false) return;

				if (!ctx.content) return;

				// Check if this save creates a content gap scenario
				const result = await ctx.content.list(event.collection, { limit: 100 });
				const totalInCollection = result.items.length;

				if (totalInCollection < MIN_COLLECTION_POSTS) {
					ctx.log.info(
						`Content gap detected: ${event.collection} has only ${totalInCollection} post(s), below the ${MIN_COLLECTION_POSTS}-post threshold.`,
					);
				}

				// Check if saved content is missing SEO metadata
				const data = event.content;
				const hasMetaTitle = typeof data.meta_title === "string" && data.meta_title.length > 0;
				const hasSeoTitle = typeof data.seo_title === "string" && data.seo_title.length > 0;
				if (!hasMetaTitle && !hasSeoTitle) {
					ctx.log.info(
						`Content in ${event.collection} saved without SEO metadata -- consider adding a meta title and description.`,
					);
				}
			},
		},
	},

	routes: {
		handleAnalysis: {
			handler: async (
				routeCtx: { input: unknown; request: { url: string } },
				ctx: PluginContext,
			) => {
				const analysisEnabled = await ctx.kv.get<boolean>("settings:analysisEnabled");
				if (analysisEnabled === false) {
					return { error: "Analysis is disabled in plugin settings." };
				}

				if (!ctx.content) {
					return {
						error: "Content access is not available. Plugin requires read:content capability.",
					};
				}

				// Accept collections list from input
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const collectionNames = Array.isArray(input.collections)
					? (input.collections as string[]).filter((c): c is string => typeof c === "string")
					: [];

				if (collectionNames.length === 0) {
					return {
						error: 'No collections provided. Pass { collections: ["posts", ...] } in the request.',
					};
				}

				const now = Date.now();
				const collections: CollectionAnalysis[] = [];

				for (const collection of collectionNames) {
					const items = await fetchAllContent(ctx.content, collection);

					const missingSeoMetadata = items.filter((item) => isMissingSeoMetadata(item));
					const stalePosts = items.filter((item) => isStale(item, now));

					collections.push({
						collection,
						totalPosts: items.length,
						missingSeoMetadata,
						stalePosts,
					});
				}

				const recommendations = buildRecommendations(collections);

				const totalContent = collections.reduce((sum, c) => sum + c.totalPosts, 0);
				const totalMissingSeo = collections.reduce(
					(sum, c) => sum + c.missingSeoMetadata.length,
					0,
				);
				const totalStale = collections.reduce((sum, c) => sum + c.stalePosts.length, 0);
				const underservedCollections = collections
					.filter((c) => c.totalPosts < MIN_COLLECTION_POSTS)
					.map((c) => c.collection);

				const report: AnalysisReport = {
					timestamp: new Date().toISOString(),
					collections,
					recommendations,
					summary: {
						totalContent,
						totalMissingSeo,
						totalStale,
						underservedCollections,
					},
				};

				return report;
			},
		},

		settings: {
			handler: async (_routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				const analysisEnabled = (await ctx.kv.get<boolean>("settings:analysisEnabled")) ?? true;
				const targetAudience = (await ctx.kv.get<string>("settings:targetAudience")) ?? "";

				return { analysisEnabled, targetAudience };
			},
		},

		"settings/save": {
			handler: async (routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};

				if (typeof input.analysisEnabled === "boolean") {
					await ctx.kv.set("settings:analysisEnabled", input.analysisEnabled);
				}
				if (typeof input.targetAudience === "string") {
					await ctx.kv.set("settings:targetAudience", input.targetAudience);
				}

				return { success: true };
			},
		},

		status: {
			handler: async (_routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				const analysisEnabled = (await ctx.kv.get<boolean>("settings:analysisEnabled")) ?? true;
				const targetAudience = (await ctx.kv.get<string>("settings:targetAudience")) ?? "";

				return {
					enabled: analysisEnabled,
					targetAudience: targetAudience || "Not configured",
				};
			},
		},
	},
});
