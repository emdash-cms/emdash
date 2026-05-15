/**
 * Sandbox Entry Point -- Audit Log
 *
 * Canonical plugin implementation using the standard format.
 * Runs in both trusted (in-process) and sandboxed (isolate) modes.
 *
 * Note: The beforeSaveCache is module-scoped. In sandbox isolates that persist
 * across hook invocations within a request, this works correctly. In isolates
 * that don't persist, updates will be logged without "before" state (graceful
 * degradation -- the entry is still recorded).
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

interface ContentSaveEvent {
	content: Record<string, unknown> & {
		id?: string | number;
		slug?: string;
		status?: string;
		data?: Record<string, unknown>;
	};
	collection: string;
	isNew: boolean;
}

interface ContentDeleteEvent {
	id: string;
	collection: string;
}

interface MediaUploadEvent {
	media: { id: string };
}

interface AuditEntry {
	timestamp: string;
	action: "create" | "update" | "delete" | "media:upload" | "media:delete";
	collection?: string;
	resourceId: string;
	resourceType: "content" | "media";
	userId?: string;
	changes?: {
		before?: Record<string, unknown>;
		after?: Record<string, unknown>;
	};
	metadata?: Record<string, unknown>;
}

// ── Helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuditEntry(value: unknown): value is AuditEntry {
	return (
		isRecord(value) &&
		typeof value.timestamp === "string" &&
		typeof value.action === "string" &&
		typeof value.resourceId === "string" &&
		typeof value.resourceType === "string"
	);
}

// In-memory cache for content state before save/delete.
// Works within a single request lifecycle if the isolate persists.
const beforeSaveCache = new Map<string, unknown>();

// ── Plugin definition ──

export default definePlugin({
	hooks: {
		"plugin:install": async (_event: unknown, ctx: PluginContext) => {
			ctx.log.info("Audit log plugin installed");
		},

		"plugin:activate": async (_event: unknown, ctx: PluginContext) => {
			ctx.log.info("Audit log plugin activated");
		},

		"plugin:deactivate": async (_event: unknown, ctx: PluginContext) => {
			ctx.log.info("Audit log plugin deactivated");
		},

		"plugin:uninstall": async (_event: unknown, ctx: PluginContext) => {
			ctx.log.info("Audit log plugin uninstalled");
		},

		"content:beforeSave": {
			handler: async (event: ContentSaveEvent, ctx: PluginContext) => {
				if (!event.isNew && event.content.id) {
					const contentId =
						typeof event.content.id === "string" ? event.content.id : String(event.content.id);
					try {
						if (ctx.content) {
							const existing = await ctx.content.get(event.collection, contentId);
							if (existing) {
								beforeSaveCache.set(`${event.collection}:${contentId}`, existing);
							}
						}
					} catch {
						// Ignore -- best effort
					}
				}
				return event.content;
			},
		},

		"content:afterSave": {
			handler: async (event: ContentSaveEvent, ctx: PluginContext) => {
				const contentId =
					typeof event.content.id === "string" ? event.content.id : String(event.content.id ?? "");
				const cacheKey = `${event.collection}:${contentId}`;
				const before = beforeSaveCache.get(cacheKey);
				beforeSaveCache.delete(cacheKey);

				const beforeRecord = isRecord(before) ? before : undefined;
				const afterRecord = isRecord(event.content.data) ? event.content.data : undefined;

				const entry: AuditEntry = {
					timestamp: new Date().toISOString(),
					action: event.isNew ? "create" : "update",
					collection: event.collection,
					resourceId: contentId,
					resourceType: "content",
					changes:
						beforeRecord || afterRecord ? { before: beforeRecord, after: afterRecord } : undefined,
					metadata: { slug: event.content.slug, status: event.content.status },
				};

				try {
					await ctx.storage.entries!.put(`${Date.now()}-${contentId}`, entry);
				} catch (error) {
					ctx.log.error("Failed to persist entry", error);
				}

				const icon = event.isNew ? "+" : "~";
				ctx.log.info(`${icon} ${entry.action} content/${event.collection}/${contentId}`);
			},
		},

		"content:beforeDelete": {
			handler: async (event: ContentDeleteEvent, ctx: PluginContext) => {
				if (ctx.content) {
					try {
						const existing = await ctx.content.get(event.collection, event.id);
						if (existing) {
							beforeSaveCache.set(`delete:${event.collection}:${event.id}`, existing);
						}
					} catch {
						// Ignore
					}
				}
				return true;
			},
		},

		"content:afterDelete": {
			handler: async (event: ContentDeleteEvent, ctx: PluginContext) => {
				const cacheKey = `delete:${event.collection}:${event.id}`;
				const beforeData = beforeSaveCache.get(cacheKey);
				beforeSaveCache.delete(cacheKey);

				const beforeRecord = isRecord(beforeData) ? beforeData : undefined;
				const entry: AuditEntry = {
					timestamp: new Date().toISOString(),
					action: "delete",
					collection: event.collection,
					resourceId: event.id,
					resourceType: "content",
					changes: beforeRecord ? { before: beforeRecord } : undefined,
				};

				try {
					await ctx.storage.entries!.put(`${Date.now()}-${event.id}`, entry);
				} catch (error) {
					ctx.log.error("Failed to persist entry", error);
				}

				ctx.log.info(`- delete content/${event.collection}/${event.id}`);
			},
		},

		"media:afterUpload": {
			handler: async (event: MediaUploadEvent, ctx: PluginContext) => {
				const entry: AuditEntry = {
					timestamp: new Date().toISOString(),
					action: "media:upload",
					resourceId: event.media.id,
					resourceType: "media",
				};

				try {
					await ctx.storage.entries!.put(`${Date.now()}-${event.media.id}`, entry);
				} catch (error) {
					ctx.log.error("Failed to persist entry", error);
				}

				ctx.log.info(`+ media:upload media/${event.media.id}`);
			},
		},
	},

	routes: {
		// Block Kit admin handler -- returns plain block objects (no @emdash-cms/blocks import needed)
		admin: {
			handler: async (
				routeCtx: { input: unknown; request: { url: string } },
				ctx: PluginContext,
			) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					value?: string;
				};

				if (interaction.type === "page_load" && interaction.page === "/history") {
					return buildHistoryBlocks(ctx);
				}
				if (interaction.type === "page_load" && interaction.page === "widget:recent-activity") {
					return buildRecentBlocks(ctx);
				}
				if (interaction.type === "block_action" && interaction.action_id === "load-page") {
					return buildHistoryBlocks(ctx, interaction.value);
				}
				return { blocks: [] };
			},
		},

		recent: {
			handler: async (
				_routeCtx: { input: unknown; request: { url: string } },
				ctx: PluginContext,
			) => {
				try {
					const result = await ctx.storage.entries!.query({
						orderBy: { timestamp: "desc" },
						limit: 5,
					});
					return {
						entries: result.items
							.filter((item: { id: string; data: unknown }) => isAuditEntry(item.data))
							.map((item: { id: string; data: unknown }) => ({
								id: item.id,
								...(item.data as AuditEntry),
							})),
					};
				} catch (error) {
					ctx.log.error("Failed to fetch recent entries", error);
					return { entries: [] };
				}
			},
		},

		history: {
			handler: async (
				routeCtx: { input: unknown; request: { url: string } },
				ctx: PluginContext,
			) => {
				try {
					const url = new URL(routeCtx.request.url);
					const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100);
					const cursor = url.searchParams.get("cursor") || undefined;

					const result = await ctx.storage.entries!.query({
						orderBy: { timestamp: "desc" },
						limit,
						cursor,
					});
					return {
						entries: result.items
							.filter((item: { id: string; data: unknown }) => isAuditEntry(item.data))
							.map((item: { id: string; data: unknown }) => ({
								id: item.id,
								...(item.data as AuditEntry),
							})),
						cursor: result.cursor,
						hasMore: result.hasMore,
					};
				} catch (error) {
					ctx.log.error("Failed to fetch history", error);
					return { entries: [], cursor: undefined, hasMore: false };
				}
			},
		},
	},
});

// ── Block Kit helpers (plain objects, no @emdash-cms/blocks import) ──

async function buildHistoryBlocks(ctx: PluginContext, cursor?: string) {
	try {
		const result = await ctx.storage.entries!.query({
			orderBy: { timestamp: "desc" },
			limit: 50,
			cursor,
		});
		const entries = result.items
			.filter((item: { id: string; data: unknown }) => isAuditEntry(item.data))
			.map((item: { id: string; data: unknown }) => ({
				id: item.id,
				...(item.data as AuditEntry),
			}));

		return {
			blocks: [
				{ type: "header", text: "Audit History" },
				{ type: "context", text: "Track all content and media changes" },
				{ type: "divider" },
				{
					type: "table",
					blockId: "history-table",
					columns: [
						{ key: "action", label: "Action", format: "badge" },
						{ key: "resource", label: "Resource", format: "code" },
						{ key: "collection", label: "Collection", format: "text" },
						{ key: "time", label: "Time", format: "relative_time" },
					],
					rows: entries.map((e) => ({
						action: e.action,
						resource: e.resourceId,
						collection: e.collection ?? "-",
						time: e.timestamp,
					})),
					pageActionId: "load-page",
					nextCursor: result.cursor,
					emptyText: "No audit entries yet",
				},
				{ type: "context", text: `Showing ${entries.length} entries` },
			],
		};
	} catch (error) {
		ctx.log.error("Failed to fetch history", error);
		return { blocks: [{ type: "context", text: "Failed to load audit history" }] };
	}
}

async function buildRecentBlocks(ctx: PluginContext) {
	try {
		const result = await ctx.storage.entries!.query({
			orderBy: { timestamp: "desc" },
			limit: 5,
		});
		const entries = result.items
			.filter((item: { id: string; data: unknown }) => isAuditEntry(item.data))
			.map((item: { id: string; data: unknown }) => ({
				id: item.id,
				...(item.data as AuditEntry),
			}));

		if (entries.length === 0) {
			return { blocks: [{ type: "context", text: "No recent activity" }] };
		}

		return {
			blocks: [
				{
					type: "fields",
					fields: entries.slice(0, 4).map((e) => ({
						label: e.action,
						value: `${e.collection ? `${e.collection}/` : ""}${e.resourceId}`,
					})),
				},
				{ type: "context", text: `${entries.length} changes` },
			],
		};
	} catch (error) {
		ctx.log.error("Failed to fetch recent activity", error);
		return { blocks: [{ type: "context", text: "Failed to load activity" }] };
	}
}
