/**
 * AI Moderation Plugin
 *
 * Uses Cloudflare Workers AI (Llama Guard 3 8B) to moderate comments.
 * Registers as the exclusive comment:moderate provider, replacing the
 * built-in default moderator unless the site has already stored a
 * comment:moderate selection.
 */

import type { ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import { DEFAULT_CATEGORIES, buildTaxonomy } from "./categories.js";
import type { Category } from "./categories.js";
import { computeDecision } from "./decision.js";
import type { AIModerationOptions } from "./descriptor.js";
import { runGuard } from "./guard.js";
import type { GuardResult } from "./guard.js";

/** KV key for stored categories */
const KV_CATEGORIES = "config:categories";
/** KV key for behavior settings */
const KV_BEHAVIOR = "config:behavior";

/** Narrow unknown to a record */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Create the AI moderation plugin.
 */
export function createPlugin(options: AIModerationOptions = {}): ResolvedPlugin {
	const defaultAutoApprove = options.autoApproveClean ?? true;
	const aiBinding = options.aiBinding ?? "AI";

	/** Load categories from KV or fall back to options/defaults */
	async function loadCategories(kv: {
		get: <T>(key: string) => Promise<T | null>;
	}): Promise<Category[]> {
		const stored = await kv.get<Category[]>(KV_CATEGORIES);
		return stored ?? options.categories ?? DEFAULT_CATEGORIES;
	}

	/** Load behavior settings from KV or fall back to defaults */
	async function loadBehavior(kv: {
		get: <T>(key: string) => Promise<T | null>;
	}): Promise<{ autoApproveClean: boolean }> {
		const stored = await kv.get<{ autoApproveClean: boolean }>(KV_BEHAVIOR);
		return stored ?? { autoApproveClean: defaultAutoApprove };
	}

	return definePlugin({
		id: "ai-moderation",
		version: "0.1.0",
		// Comment hooks receive the commenter's email and IP hash, so EmDash
		// only registers them for plugins that declare `users:read`.
		capabilities: ["users:read"],
		allowedHosts: [],

		admin: {
			entry: "@emdash-cms/plugin-ai-moderation/admin",
			pages: [{ path: "/settings", label: "AI Moderation", icon: "shield" }],
			widgets: [{ id: "status", title: "AI Moderation", size: "third" }],
		},

		hooks: {
			// Enrichment hook — runs AI guard, writes signals to metadata
			"comment:beforeCreate": {
				priority: 10,
				errorPolicy: "continue",
				handler: async (event, ctx) => {
					const categories = await loadCategories(ctx.kv);

					// Run AI guard (try/catch — failure is non-fatal)
					let guard: GuardResult | undefined;
					let guardError: string | undefined;

					const taxonomy = buildTaxonomy(categories);
					if (taxonomy) {
						try {
							guard = await runGuard(event.comment.body, taxonomy, aiBinding);
						} catch (error) {
							guardError = "AI classification failed";
							ctx.log.error("AI guard failed", {
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}

					// Write signals to metadata for the moderator
					event.metadata.aiGuard = guard;
					event.metadata.aiGuardError = guardError;

					return event;
				},
			},

			// Exclusive moderator — reads metadata signals, computes decision
			"comment:moderate": {
				exclusive: true,
				handler: async (event, ctx) => {
					const categories = await loadCategories(ctx.kv);
					const behavior = await loadBehavior(ctx.kv);

					// Read signals from metadata (written by beforeCreate hook)
					const guard = event.metadata.aiGuard as GuardResult | undefined;
					const guardError = event.metadata.aiGuardError as string | undefined;

					const isAuthenticated = !!event.comment.authorUserId;

					return computeDecision(
						guard,
						guardError,
						categories,
						behavior,
						event.collectionSettings,
						event.priorApprovedCount,
						isAuthenticated,
					);
				},
			},
		},

		routes: {
			// Get current settings
			settings: {
				handler: async (ctx) => {
					const categories = await loadCategories(ctx.kv);
					const behavior = await loadBehavior(ctx.kv);

					return { categories, behavior };
				},
			},

			// Save settings
			"settings/save": {
				handler: async (ctx) => {
					const input = isRecord(ctx.input) ? ctx.input : {};

					if (Array.isArray(input.categories)) {
						const cats = input.categories as Category[];
						const seenIds = new Set<string>();
						for (const cat of cats) {
							if (
								typeof cat.id !== "string" ||
								typeof cat.name !== "string" ||
								typeof cat.description !== "string" ||
								!cat.id ||
								!cat.name ||
								!cat.description ||
								cat.id.length > 10 ||
								cat.name.length > 100 ||
								cat.description.length > 500 ||
								!["block", "hold", "ignore"].includes(cat.action)
							) {
								return {
									success: false,
									error: `Invalid category: ${typeof cat.id === "string" ? cat.id : "missing id"}`,
								};
							}
							if (seenIds.has(cat.id)) {
								return {
									success: false,
									error: `Duplicate category ID: ${cat.id}`,
								};
							}
							seenIds.add(cat.id);
						}
						await ctx.kv.set(KV_CATEGORIES, cats);
					}

					if (isRecord(input.behavior)) {
						const behavior = {
							autoApproveClean:
								typeof input.behavior.autoApproveClean === "boolean"
									? input.behavior.autoApproveClean
									: defaultAutoApprove,
						};
						await ctx.kv.set(KV_BEHAVIOR, behavior);
					}

					return { success: true };
				},
			},

			// Test AI analysis on sample text
			"settings/test": {
				handler: async (ctx) => {
					const input = isRecord(ctx.input) ? ctx.input : {};
					const text = typeof input.text === "string" ? input.text : "";

					if (!text.trim()) {
						return { success: false, error: "No text provided" };
					}

					const categories = await loadCategories(ctx.kv);

					// Run AI guard
					let guard: GuardResult | undefined;
					let guardError: string | undefined;
					const taxonomy = buildTaxonomy(categories);

					if (taxonomy) {
						try {
							guard = await runGuard(text, taxonomy, aiBinding);
						} catch (error) {
							guardError = error instanceof Error ? error.message : String(error);
						}
					}

					return {
						success: true,
						guard: guard ?? null,
						guardError: guardError ?? null,
						taxonomy,
					};
				},
			},

			// Plugin status for dashboard widget
			status: {
				handler: async (ctx) => {
					const categories = await loadCategories(ctx.kv);
					const behavior = await loadBehavior(ctx.kv);

					return {
						enabled: true,
						categoryCount: categories.filter((c) => c.action !== "ignore").length,
						autoApproveClean: behavior.autoApproveClean,
					};
				},
			},
		},
	});
}

export default createPlugin;
