import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

let isolateId: string | undefined;
let recordSequence = 0;

async function record(
	ctx: PluginContext,
	collection: string,
	type: string,
	data: Record<string, unknown> = {},
) {
	await ctx.storage[collection]!.put(String(++recordSequence).padStart(8, "0"), { type, ...data });
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => record(ctx, "lifecycle", "install"),
		"plugin:activate": async (_event, ctx) => record(ctx, "lifecycle", "activate"),
		"plugin:deactivate": async (_event, ctx) => record(ctx, "lifecycle", "deactivate"),
		"plugin:uninstall": async (event, ctx) =>
			record(ctx, "lifecycle", "uninstall", { deleteData: event.deleteData }),
		"content:beforeSave": async (event) => ({
			...event.content,
			title: `${String(event.content.title)} [sandbox]`,
		}),
		"content:afterSave": {
			handler: async (event, ctx) => {
				await ctx.storage.events!.put(String(event.content.id), {
					type: "saved",
					collection: event.collection,
				});
			},
		},
		"media:beforeUpload": async (event) => ({
			...event.file,
			name: `checked-${event.file.name}`,
			size: event.file.size + 1,
		}),
		"media:afterUpload": async (event, ctx) =>
			record(ctx, "events", "media-uploaded", {
				mediaId: event.media.id,
				size: event.media.size,
			}),
		"comment:afterCreate": async (event, ctx) =>
			record(ctx, "events", "comment-created", { commentId: event.comment.id }),
		"comment:afterModerate": async (event, ctx) =>
			record(ctx, "events", "comment-moderated", {
				commentId: event.comment.id,
				status: event.newStatus,
			}),
		cron: async (event, ctx) =>
			record(ctx, "events", "cron", { name: event.name, scheduledAt: event.scheduledAt }),
	},
	routes: {
		"isolate-id": {
			public: true,
			cacheControl: "public, max-age=60",
			handler: async () => ({ isolateId: (isolateId ??= crypto.randomUUID()) }),
		},
		"site-info": {
			public: true,
			handler: async (_route, ctx) => ctx.site,
		},
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
		"content-discovery": {
			permission: "content:read",
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("id" in route.input) ||
					typeof route.input.id !== "string"
				) {
					throw new Error("Expected a content ID");
				}
				const id = route.input.id;
				return {
					schema: await ctx.schema!.getCollection("posts"),
					item: await ctx.content!.get("posts", id),
					translations: await ctx.content!.getTranslations!("posts", id),
					publicUrl: await ctx.content!.getPublicUrl!("posts", id),
					revisions: await ctx.content!.listRevisions!("posts", id),
				};
			},
		},
		"revision-discovery": {
			permission: "content:read",
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("id" in route.input) ||
					typeof route.input.id !== "string" ||
					!("revisionId" in route.input) ||
					typeof route.input.revisionId !== "string"
				) {
					throw new Error("Expected content and revision IDs");
				}
				return {
					list: await ctx.content!.listRevisions!("posts", route.input.id),
					item: await ctx.content!.getRevision!("posts", route.input.id, route.input.revisionId),
				};
			},
		},
		"settings-value": {
			handler: async (_route, ctx) => ({
				enabled: await ctx.kv.get("settings:enabled"),
			}),
		},
		"settings-update": {
			handler: async (route, ctx) => {
				const enabled =
					typeof route.input === "object" &&
					route.input !== null &&
					"enabled" in route.input &&
					route.input.enabled === true;
				await ctx.kv.set("settings:enabled", enabled);
				return { enabled };
			},
		},
		"private-user": {
			permission: "content:edit_any",
			handler: async (route) => ({ userId: route.user?.id ?? null }),
		},
		"schedule-once": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("at" in route.input) ||
					typeof route.input.at !== "string"
				) {
					throw new Error("Expected an ISO timestamp");
				}
				const at = route.input.at;
				const name =
					"name" in route.input && typeof route.input.name === "string"
						? route.input.name
						: "runtime-test";
				await ctx.cron!.schedule(name, { schedule: at });
				return { scheduled: true };
			},
		},
		"send-email": {
			handler: async (_route, ctx) => {
				await ctx.email!.send({
					to: "author@example.com",
					subject: "Runtime host",
					text: "Captured by the test host",
				});
				return { sent: true };
			},
		},
	},
};

export default plugin;
