import type { SandboxedPlugin } from "emdash/plugin";

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": {
			handler: async (event, ctx) => {
				await ctx.storage.events!.put(String(event.content.id), {
					type: "saved",
					collection: event.collection,
				});
			},
		},
	},
	routes: {
		hello: {
			public: true,
			cacheControl: "public, max-age=60",
			handler: async (_route, ctx) => {
				await ctx.kv.set("last-route", "hello");
				return { pluginId: ctx.plugin.id };
			},
		},
		"content-count": {
			permission: "content:read",
			handler: async (_route, ctx) => {
				const result = await ctx.content!.list("posts");
				return { count: result.items.length };
			},
		},
	},
};

export default plugin;
