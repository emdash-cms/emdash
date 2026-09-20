import {
	pluginResponse,
	pluginRoute,
	type ContentPolicyEvent,
	type PluginContext,
	type RedirectCreateInput,
	type RedirectListOptions,
	type RedirectStatus,
	type RedirectUpdateInput,
	type SandboxedPlugin,
} from "emdash/plugin";

let isolateId: string | undefined;
let recordSequence = 0;

type RedirectCreateProbeInput = RedirectCreateInput & { auto?: unknown };
type RedirectUpdateProbeInput = RedirectUpdateInput & { _rev: string; auto?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
	return value;
}

function optionalNullableString(
	input: Record<string, unknown>,
	key: string,
): string | null | undefined {
	const value = input[key];
	if (value === undefined || value === null) return value;
	if (typeof value !== "string") throw new Error(`${key} must be a string or null`);
	return value;
}

function optionalStatus(input: Record<string, unknown>): RedirectStatus | undefined {
	switch (input.type) {
		case undefined:
		case 301:
		case 302:
		case 307:
		case 308:
		case 410:
		case 451:
			return input.type;
		default:
			throw new Error("type must be a supported redirect status");
	}
}

function redirectListOptions(value: unknown): RedirectListOptions {
	if (!isRecord(value)) throw new Error("options must be an object");
	const limit = value.limit;
	if (limit !== undefined && typeof limit !== "number") throw new Error("limit must be a number");
	return {
		limit,
		cursor: optionalString(value, "cursor"),
		search: optionalString(value, "search"),
		group: optionalString(value, "group"),
		enabled: optionalBoolean(value, "enabled"),
		auto: optionalBoolean(value, "auto"),
	};
}

function redirectCreateInput(value: unknown): RedirectCreateProbeInput {
	if (!isRecord(value) || typeof value.source !== "string") {
		throw new Error("redirect.source must be a string");
	}
	return {
		source: value.source,
		destination: optionalString(value, "destination"),
		type: optionalStatus(value),
		enabled: optionalBoolean(value, "enabled"),
		groupName: optionalNullableString(value, "groupName"),
		...(Object.hasOwn(value, "auto") ? { auto: value.auto } : {}),
	};
}

function redirectUpdateInput(value: unknown): RedirectUpdateProbeInput {
	if (!isRecord(value) || typeof value._rev !== "string") {
		throw new Error("redirect._rev must be a string");
	}
	return {
		_rev: value._rev,
		source: optionalString(value, "source"),
		destination: optionalString(value, "destination"),
		type: optionalStatus(value),
		enabled: optionalBoolean(value, "enabled"),
		groupName: optionalNullableString(value, "groupName"),
		...(Object.hasOwn(value, "auto") ? { auto: value.auto } : {}),
	};
}

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

async function recordContentAction(ctx: PluginContext, action: string, contentId: string) {
	await ctx.storage.events!.put(`action:${action}:${contentId}`, {
		type: "content-action",
		action,
		contentId,
	});
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => record(ctx, "lifecycle", "install"),
		"plugin:activate": async (_event, ctx) => record(ctx, "lifecycle", "activate"),
		"plugin:deactivate": async (_event, ctx) => record(ctx, "lifecycle", "deactivate"),
		"plugin:uninstall": async (event, ctx) =>
			record(ctx, "lifecycle", "uninstall", { deleteData: event.deleteData }),
		"content:beforeSave": async (event, ctx) => {
			if (event.content.rejectSave === true) {
				return {
					__emdashSandboxHookResult: true,
					version: 1,
					error: { code: "SAVE_REJECTED", reason: "Translation needs review" },
				};
			}
			if (event.content.createCompanion === true) {
				if (!ctx.content?.create) throw new Error("Content write access is unavailable");
				await ctx.content.create("posts", { title: "Companion" });
			}
			const content = { ...event.content };
			delete content.createCompanion;
			return { ...content, title: `${String(event.content.title)} [sandbox]` };
		},
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
		"content:afterPublish": (event, ctx) =>
			recordContentAction(ctx, "publish", String(event.content.id)),
		"content:afterUnpublish": (event, ctx) =>
			recordContentAction(ctx, "unpublish", String(event.content.id)),
		"content:afterSchedule": (event, ctx) =>
			recordContentAction(ctx, "schedule", String(event.content.id)),
		"content:afterUnschedule": (event, ctx) =>
			recordContentAction(ctx, "unschedule", String(event.content.id)),
		"content:afterRestore": (event, ctx) =>
			recordContentAction(ctx, "restore", String(event.content.id)),
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
		"comment:afterModerate": async (event, ctx) => {
			await record(ctx, "events", "comment-moderated", {
				commentId: event.comment.id,
				status: event.newStatus,
				origin: event.origin,
			});
			if (event.comment.moderationMetadata?.slowModeration === true) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			if (
				event.origin?.source === "plugin" &&
				event.comment.moderationMetadata?.attemptRecursiveModeration === true
			) {
				try {
					await ctx.comments!.setStatus!(event.comment.id, "spam", {
						expectedStatus: "approved",
					});
				} catch (error) {
					await record(ctx, "events", "comment-recursion-blocked", {
						code:
							typeof error === "object" && error !== null && "code" in error ? error.code : null,
					});
				}
			}
		},
		cron: async (event, ctx) =>
			record(ctx, "events", "cron", { name: event.name, scheduledAt: event.scheduledAt }),
	},
	routes: {
		admin: {
			permission: "plugins:manage",
			handler: async (route) => {
				if (
					typeof route.input === "object" &&
					route.input !== null &&
					"action_id" in route.input &&
					route.input.action_id === "oversized-response"
				) {
					return { blocks: Array.from({ length: 1_001 }, () => ({ type: "divider" })) };
				}
				if (
					typeof route.input === "object" &&
					route.input !== null &&
					"action_id" in route.input &&
					route.input.action_id === "unsafe-image"
				) {
					return {
						blocks: [{ type: "image", url: "https://tracker.example/pixel.gif", alt: "" }],
					};
				}
				return {
					blocks: [
						{
							type: "fields",
							fields: [
								{ label: "Surface", value: route.ui?.surface ?? "missing" },
								{ label: "Locale", value: route.ui?.locale ?? "missing" },
								{ label: "Direction", value: route.ui?.direction ?? "missing" },
							],
						},
						{
							type: "actions",
							elements: [
								{
									type: "link",
									label: "Plugin overview",
									target: { kind: "plugin-page", path: "/overview" },
								},
								{
									type: "link",
									label: "Documentation",
									target: { kind: "external", url: "https://docs.example.test/plugin" },
								},
							],
						},
						{ type: "image", url: "/plugin-assets/status.png", alt: "Plugin status" },
					],
				};
			},
		},
		"entry-context": {
			permission: "content:edit_own",
			handler: async (route) => {
				if (route.ui?.surface !== "content-editor-panel") {
					throw new Error("Expected editor panel context");
				}
				if (
					typeof route.input === "object" &&
					route.input !== null &&
					"action_id" in route.input &&
					route.input.action_id === "invalid"
				) {
					return { blocks: [{ type: "unknown" }] };
				}
				return {
					blocks: [
						{
							type: "fields",
							fields: [
								{ label: "Surface", value: route.ui.surface },
								{ label: "Extension", value: route.ui.extensionId },
								{ label: "Collection", value: route.ui.entry.collection },
								{ label: "Entry", value: route.ui.entry.id },
								{ label: "Content locale", value: route.ui.entry.locale ?? "missing" },
								{ label: "Version", value: String(route.ui.entry.version) },
							],
						},
					],
				};
			},
		},
		"refresh-entry": {
			permission: "content:edit_own",
			handler: async (route) => {
				if (route.ui?.surface !== "content-editor-action") {
					throw new Error("Expected editor action context");
				}
				return {
					refresh: true,
					toast: {
						type: "success",
						message: `${route.ui.entry.collection}/${route.ui.entry.id} refreshed`,
					},
				};
			},
		},
		"invalid-action": {
			permission: "content:edit_own",
			handler: async () => ({ refresh: true, navigate: { kind: "plugin-settings" } }),
		},
		"raw-download": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "bytes", maxBytes: 1024 },
			response: "raw",
			handler: async (route) =>
				pluginResponse({
					status: 202,
					headers: { "content-type": "application/octet-stream" },
					body: { kind: "bytes", value: route.input },
				}),
		}),
		"declared-headers": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "none", headers: ["x-signature"] },
			handler: async (route) => ({
				signature: route.request.headers["x-signature"] ?? "missing",
				hidden: route.request.headers["x-hidden"] ?? "missing",
			}),
		}),
		"raw-form": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "form-data", maxBytes: 4096 },
			handler: async (route) => ({
				entries: route.input.entries.map((entry) =>
					entry.kind === "file" ? { ...entry, bytes: [...entry.bytes] } : entry,
				),
			}),
		}),
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
		"media-get": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("id" in route.input) ||
					typeof route.input.id !== "string"
				) {
					throw new Error("Expected a media ID");
				}
				return ctx.media!.get(route.input.id);
			},
		},
		"media-read-bytes": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("id" in route.input) ||
					typeof route.input.id !== "string"
				) {
					throw new Error("Expected a media ID");
				}
				const maxBytes =
					"maxBytes" in route.input && typeof route.input.maxBytes === "number"
						? route.input.maxBytes
						: undefined;
				const result = await ctx.media!.readBytes!(route.input.id, { maxBytes });
				return { ...result, bytes: [...result.bytes] };
			},
		},
		"media-update-alt": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("id" in route.input) ||
					typeof route.input.id !== "string" ||
					!("alt" in route.input) ||
					(route.input.alt !== null && typeof route.input.alt !== "string")
				) {
					throw new Error("Expected a media ID and alt text");
				}
				return ctx.media!.updateMetadata!(route.input.id, { alt: route.input.alt });
			},
		},
		"comments-read": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("id" in route.input) ||
					typeof route.input.id !== "string"
				) {
					throw new Error("Expected a comment id");
				}
				return {
					comment: await ctx.comments!.get(route.input.id),
					page: await ctx.comments!.list({ limit: 1 }),
					count: await ctx.comments!.count(),
				};
			},
		},
		"comments-moderate": {
			handler: async (route, ctx) => {
				if (typeof route.input !== "object" || route.input === null) {
					throw new Error("Expected moderation input");
				}
				const id = "id" in route.input && typeof route.input.id === "string" ? route.input.id : "";
				const status =
					"status" in route.input &&
					(route.input.status === "approved" ||
						route.input.status === "pending" ||
						route.input.status === "spam")
						? route.input.status
						: "pending";
				const expectedStatus =
					"expectedStatus" in route.input &&
					(route.input.expectedStatus === "approved" ||
						route.input.expectedStatus === "pending" ||
						route.input.expectedStatus === "spam")
						? route.input.expectedStatus
						: "pending";
				try {
					return await ctx.comments!.setStatus!(id, status, { expectedStatus });
				} catch (error) {
					return {
						error: {
							code:
								typeof error === "object" && error !== null && "code" in error ? error.code : null,
							currentStatus:
								typeof error === "object" && error !== null && "currentStatus" in error
									? error.currentStatus
									: null,
						},
					};
				}
			},
		},
		"comments-invalid-status": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("id" in route.input) ||
					typeof route.input.id !== "string"
				) {
					throw new Error("Expected a comment id");
				}
				try {
					// @ts-expect-error -- proves the runtime rejects untrusted values that bypass types
					await ctx.comments!.setStatus!(route.input.id, "trash", {
						expectedStatus: "pending",
					});
					return { rejected: false };
				} catch (error) {
					return {
						rejected: true,
						message: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},
		"taxonomy-create": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("taxonomy" in route.input) ||
					typeof route.input.taxonomy !== "string" ||
					!("label" in route.input) ||
					typeof route.input.label !== "string"
				) {
					throw new Error("Expected taxonomy and label");
				}
				return ctx.taxonomies!.createTerm!(route.input.taxonomy, { label: route.input.label });
			},
		},
		"taxonomy-add": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("entryId" in route.input) ||
					typeof route.input.entryId !== "string" ||
					!("termIds" in route.input) ||
					!Array.isArray(route.input.termIds) ||
					!route.input.termIds.every((id) => typeof id === "string")
				) {
					throw new Error("Expected entryId and termIds");
				}
				return ctx.taxonomies!.addEntryTerms!(
					"posts",
					route.input.entryId,
					"category",
					route.input.termIds,
				);
			},
		},
		"taxonomy-remove": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("entryId" in route.input) ||
					typeof route.input.entryId !== "string" ||
					!("termIds" in route.input) ||
					!Array.isArray(route.input.termIds) ||
					!route.input.termIds.every((id) => typeof id === "string")
				) {
					throw new Error("Expected entryId and termIds");
				}
				return ctx.taxonomies!.removeEntryTerms!(
					"posts",
					route.input.entryId,
					"category",
					route.input.termIds,
				);
			},
		},
		redirects: {
			permission: "redirects:manage",
			handler: async (route, ctx) => {
				if (!isRecord(route.input)) {
					throw new Error("Expected redirect operation input");
				}
				const input = route.input;
				const operation = input.operation;
				try {
					if (operation === "list") {
						return await ctx.redirects!.list(redirectListOptions(input.options ?? {}));
					}
					if (operation === "get") return await ctx.redirects!.get(String(input.id));
					if (operation === "create") {
						return await ctx.redirects!.create!(redirectCreateInput(input.redirect));
					}
					if (operation === "update") {
						return await ctx.redirects!.update!(
							String(input.id),
							redirectUpdateInput(input.redirect),
						);
					}
					if (operation === "delete") {
						return {
							deleted: await ctx.redirects!.delete!(String(input.id), {
								_rev: String(input._rev),
							}),
						};
					}
					throw new Error("Unknown redirect operation");
				} catch (error) {
					return {
						error: {
							code:
								typeof error === "object" && error !== null && "code" in error
									? String(error.code)
									: "UNKNOWN",
							message: error instanceof Error ? error.message : "Redirect operation failed",
						},
					};
				}
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
		"content-translation-create": {
			permission: "content:create",
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("translationOf" in route.input) ||
					typeof route.input.translationOf !== "string" ||
					!("locale" in route.input) ||
					typeof route.input.locale !== "string" ||
					!("data" in route.input) ||
					typeof route.input.data !== "object" ||
					route.input.data === null
				) {
					throw new Error("Expected translationOf, locale, and data");
				}
				if (!ctx.content?.create) throw new Error("Content write access is unavailable");
				const options = {
					locale: route.input.locale,
					translationOf: route.input.translationOf,
					__emdashOriginHook: "content:beforeSave",
				};
				return ctx.content.create(
					"posts",
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-null record above
					route.input.data as Record<string, unknown>,
					options,
				);
			},
		},
		"content-translation-error": {
			permission: "content:create",
			handler: async (route, ctx) => {
				if (!ctx.content?.create) throw new Error("Content write access is unavailable");
				if (typeof route.input !== "object" || route.input === null) {
					throw new Error("Expected translation input");
				}
				try {
					await ctx.content.create(
						"posts",
						{ title: "Attempt" },
						{
							locale:
								"locale" in route.input && typeof route.input.locale === "string"
									? route.input.locale
									: undefined,
							translationOf:
								"translationOf" in route.input && typeof route.input.translationOf === "string"
									? route.input.translationOf
									: undefined,
						},
					);
					return { unexpectedSuccess: true };
				} catch (error) {
					return {
						name: error instanceof Error ? error.name : null,
						code:
							typeof error === "object" &&
							error !== null &&
							"code" in error &&
							typeof error.code === "string"
								? error.code
								: null,
						message: error instanceof Error ? error.message : null,
					};
				}
			},
		},
		"content-save-rejection": {
			permission: "content:create",
			handler: async (_route, ctx) => {
				if (!ctx.content?.create) throw new Error("Content write access is unavailable");
				try {
					await ctx.content.create("posts", { title: "Rejected", rejectSave: true });
					return { unexpectedSuccess: true };
				} catch (error) {
					return {
						name: error instanceof Error ? error.name : null,
						code:
							typeof error === "object" &&
							error !== null &&
							"code" in error &&
							typeof error.code === "string"
								? error.code
								: null,
					};
				}
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
		"content-action": {
			handler: async (route, ctx) => {
				if (typeof route.input !== "object" || route.input === null) {
					throw new Error("Expected content action input");
				}
				const input = route.input;
				if (!("action" in input) || !("collection" in input) || !("id" in input)) {
					throw new Error("Expected action, collection, and id");
				}
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
				if (!("_rev" in input) || typeof input._rev !== "string") {
					throw new Error("Expected _rev");
				}
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
					if (!("scheduledAt" in input) || typeof input.scheduledAt !== "string") {
						throw new Error("Expected scheduledAt");
					}
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
				enabled: await ctx.settings.get("enabled"),
			}),
		},
		"secret-value": {
			handler: async (_route, ctx) => ({
				viaSettings: await ctx.settings.get("apiKey"),
				viaCompatibilityAlias: await ctx.kv.get("settings:apiKey"),
			}),
		},
		"secret-save": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("apiKey" in route.input) ||
					typeof route.input.apiKey !== "string"
				) {
					throw new Error("Expected an API key");
				}
				await ctx.settings.set("apiKey", route.input.apiKey);
				return { saved: true };
			},
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
		"http-roundtrip": {
			handler: async (route, ctx) => {
				if (
					typeof route.input !== "object" ||
					route.input === null ||
					!("url" in route.input) ||
					typeof route.input.url !== "string"
				) {
					throw new Error("Expected an HTTP URL");
				}
				const requestBytes = new Uint8Array([0, 255, 195, 40]);
				const response = await ctx.http!.fetch(route.input.url, {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: requestBytes,
				});
				const clone = response.clone();
				return {
					status: response.status,
					statusText: response.statusText,
					url: response.url,
					redirected: response.redirected,
					contentType: response.headers.get("content-type"),
					bytes: [...new Uint8Array(await response.arrayBuffer())],
					cloneBytes: [...new Uint8Array(await clone.arrayBuffer())],
				};
			},
		},
	},
};

export default plugin;
