/**
 * Marketplace Test Plugin for EmDash CMS — sandbox entry.
 *
 * Self-contained plugin for end-to-end testing of the registry publish
 * → audit → install pipeline. Exercises the three primitives a real
 * sandboxed plugin uses: a hook (`content:beforeSave`), routes
 * (`ping`, `events`), and a storage collection (`events`).
 *
 * Identity (id, version), the trust contract (capabilities,
 * allowedHosts, storage), and the rest of the metadata live in
 * `emdash-plugin.jsonc`. This file holds runtime behaviour only.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

interface HookEvent {
	content?: Record<string, unknown>;
	collection?: string;
	isNew?: boolean;
}

export default definePlugin({
	hooks: {
		"content:beforeSave": {
			handler: async (event: HookEvent, ctx: PluginContext) => {
				ctx.log.info("[marketplace-test] beforeSave fired", {
					collection: event.collection,
					isNew: event.isNew,
				});

				// Record execution in storage so the registry's install
				// audit can verify the hook actually ran post-install.
				await ctx.storage.events.put(`hook-${Date.now()}`, {
					timestamp: new Date().toISOString(),
					type: "content:beforeSave",
					collection: event.collection,
					isNew: event.isNew,
				});

				return event.content;
			},
		},
	},

	routes: {
		ping: {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => ({
				pong: true,
				pluginId: pluginCtx.plugin.id,
				timestamp: Date.now(),
			}),
		},

		events: {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				const result = await pluginCtx.storage.events.query({ limit: 10 });
				return { count: result.items.length, items: result.items };
			},
		},
	},
});
