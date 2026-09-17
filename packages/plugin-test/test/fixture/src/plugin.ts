import type { ContentPolicyEvent, PluginContext, SandboxedPlugin } from "emdash/plugin";

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

function policyActor(event: ContentPolicyEvent) {
	return { origin: event.origin, actor: event.actor };
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
		"content:beforePublish": async (event, ctx) => {
			await record(ctx, "events", "content-policy", {
				hook: "content:beforePublish",
				...policyActor(event),
			});
			const reason = await ctx.kv.get("policy:content:beforePublish");
			if (await ctx.kv.get("policy:reenter-publish")) {
				const current = await ctx.content!.getVersioned!(
					event.collection,
					String(event.content.id),
				);
				try {
					await ctx.content!.publish!(event.collection, String(event.content.id), {
						_rev: current!._rev,
					});
				} catch (error) {
					await record(ctx, "events", "content-action-rejected", {
						code:
							typeof error === "object" &&
							error !== null &&
							"code" in error &&
							typeof error.code === "string"
								? error.code
								: "UNKNOWN",
					});
					return { cancel: true, reason: "Nested publication was blocked." };
				}
			}
			if (reason === "__invalid__") return { cancel: true, reason: "" };
			return typeof reason === "string" ? { cancel: true, reason } : undefined;
		},
		"content:beforeSchedule": async (event, ctx) => {
			await record(ctx, "events", "content-policy", {
				hook: "content:beforeSchedule",
				...policyActor(event),
				scheduledAt: event.scheduledAt,
			});
			const reason = await ctx.kv.get("policy:content:beforeSchedule");
			return typeof reason === "string" ? { cancel: true, reason } : undefined;
		},
		"content:beforeUnpublish": async (event, ctx) => {
			await record(ctx, "events", "content-policy", {
				hook: "content:beforeUnpublish",
				...policyActor(event),
			});
			const reason = await ctx.kv.get("policy:content:beforeUnpublish");
			return typeof reason === "string" ? { cancel: true, reason } : undefined;
		},
		"content:afterPublish": async (event, ctx) =>
			record(ctx, "events", "content-action", {
				action: "publish",
				contentId: event.content.id,
			}),
		"content:afterUnpublish": async (event, ctx) =>
			record(ctx, "events", "content-action", {
				action: "unpublish",
				contentId: event.content.id,
			}),
		"content:afterSchedule": async (event, ctx) =>
			record(ctx, "events", "content-action", {
				action: "schedule",
				contentId: event.content.id,
			}),
		"content:afterUnschedule": async (event, ctx) =>
			record(ctx, "events", "content-action", {
				action: "unschedule",
				contentId: event.content.id,
			}),
		"content:afterRestore": async (event, ctx) =>
			record(ctx, "events", "content-action", {
				action: "restore",
				contentId: event.content.id,
			}),
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
		"content-action": {
			handler: async (route, ctx) => {
				if (typeof route.input !== "object" || route.input === null) {
					throw new Error("Expected content action input");
				}
				const input = route.input;
				const action = input.action;
				const collection = input.collection;
				const id = input.id;
				if (
					typeof action !== "string" ||
					typeof collection !== "string" ||
					typeof id !== "string"
				) {
					throw new Error("Expected action, collection, and id");
				}
				if (action === "getTrashedVersioned") {
					return ctx.content!.getTrashedVersioned!(collection, id);
				}
				if (action === "getVersioned") return ctx.content!.getVersioned!(collection, id);
				if (typeof input._rev !== "string") throw new Error("Expected _rev");
				if (action === "publish") {
					try {
						return await ctx.content!.publish!(collection, id, { _rev: input._rev });
					} catch (error) {
						return {
							actionError: {
								code:
									typeof error === "object" &&
									error !== null &&
									"code" in error &&
									typeof error.code === "string"
										? error.code
										: "UNKNOWN",
							},
						};
					}
				}
				if (action === "unpublish") {
					return ctx.content!.unpublish!(collection, id, { _rev: input._rev });
				}
				if (action === "schedule") {
					if (typeof input.scheduledAt !== "string") throw new Error("Expected scheduledAt");
					return ctx.content!.schedule!(collection, id, {
						scheduledAt: input.scheduledAt,
						_rev: input._rev,
					});
				}
				if (action === "unschedule") {
					return ctx.content!.unschedule!(collection, id, { _rev: input._rev });
				}
				if (action === "restore")
					return ctx.content!.restore!(collection, id, { _rev: input._rev });
				throw new Error(`Unknown content action: ${action}`);
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
