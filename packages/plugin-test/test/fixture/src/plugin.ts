import type {
	PluginContext,
	RedirectCreateInput,
	RedirectListOptions,
	RedirectStatus,
	RedirectUpdateInput,
	SandboxedPlugin,
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
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-null record above
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
	},
};

export default plugin;
