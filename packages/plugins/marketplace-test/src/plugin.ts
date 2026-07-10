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

import type { SandboxedPlugin } from "emdash/plugin";

export default {
	hooks: {
		"content:beforeSave": {
			handler: async (event, ctx) => {
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
			handler: async (_routeCtx, ctx) => ({
				pong: true,
				pluginId: ctx.plugin.id,
				timestamp: Date.now(),
			}),
		},

		events: {
			handler: async (_routeCtx, ctx) => {
				const result = await ctx.storage.events.query({ limit: 10 });
				return { count: result.items.length, items: result.items };
			},
		},
	},
} satisfies SandboxedPlugin;
