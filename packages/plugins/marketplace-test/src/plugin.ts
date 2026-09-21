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
import { z } from "zod";

let isolateId: string | undefined;
let recordSequence = 0;

const diagnosticsMcpInput = z.object({});
const diagnosticsMcpOutput = z
	.object({
		plugin: z.object({ id: z.string(), version: z.string() }),
		authority: z.record(z.string(), z.boolean()),
	})
	.passthrough();
const deleteRecordMcpInput = z.object({ id: z.string().min(1) });
const deleteRecordMcpOutput = z.object({ deleted: z.boolean() });
const fixturePng = new Uint8Array([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
	0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239,
	191, 105, 69, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

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

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function optionalNullableString(
	input: Record<string, unknown>,
	key: string,
): string | null | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`${key} must be a string or null`);
	return value;
}

function optionalStatus(input: Record<string, unknown>): RedirectStatus | undefined {
	const type = input.type;
	switch (type) {
		case undefined:
		case 301:
		case 302:
		case 307:
		case 308:
		case 410:
		case 451:
			return type;
		default:
			throw new Error("type must be a supported redirect status");
	}
}

function redirectListOptions(value: unknown): RedirectListOptions {
	if (!isRecord(value)) throw new Error("options must be an object");
	if (value.limit !== undefined && typeof value.limit !== "number") {
		throw new Error("limit must be a number");
	}
	const limit = typeof value.limit === "number" ? value.limit : undefined;
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
	await ctx.storage[collection].put(String(++recordSequence).padStart(8, "0"), { type, ...data });
}

function policyActor(event: ContentPolicyEvent) {
	return { origin: event.origin, actor: event.actor };
}

async function recordContentAction(ctx: PluginContext, action: string, contentId: string) {
	await ctx.storage.events.put(`action:${action}:${contentId}`, {
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
			const title = typeof event.content.title === "string" ? event.content.title : "";
			return { ...content, title: `${title} [sandbox]` };
		},
		"content:afterSave": {
			handler: async (event, ctx) => {
				await ctx.storage.events.put(requiredString(event.content.id, "content.id"), {
					type: "saved",
					collection: event.collection,
				});
			},
		},
		"content:beforeDelete": async (event, ctx) => {
			await record(ctx, "events", "content-before-delete", {
				collection: event.collection,
				contentId: event.id,
				permanent: event.permanent,
			});
			return true;
		},
		"content:afterDelete": async (event, ctx) =>
			record(ctx, "events", "content-after-delete", {
				collection: event.collection,
				contentId: event.id,
				permanent: event.permanent,
			}),
		"content:beforePublish": async (event, ctx) => {
			await record(ctx, "events", "content-policy", {
				hook: "content:beforePublish",
				...policyActor(event),
			});
			const reason = await ctx.kv.get("policy:content:beforePublish");
			if (await ctx.kv.get("policy:reenter-publish")) {
				const current = await ctx.content.getVersioned(
					event.collection,
					requiredString(event.content.id, "content.id"),
				);
				try {
					await ctx.content.publish(
						event.collection,
						requiredString(event.content.id, "content.id"),
						{
							_rev: current._rev,
						},
					);
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
			recordContentAction(ctx, "publish", requiredString(event.content.id, "content.id")),
		"content:afterUnpublish": (event, ctx) =>
			recordContentAction(ctx, "unpublish", requiredString(event.content.id, "content.id")),
		"content:afterSchedule": (event, ctx) =>
			recordContentAction(ctx, "schedule", requiredString(event.content.id, "content.id")),
		"content:afterUnschedule": (event, ctx) =>
			recordContentAction(ctx, "unschedule", requiredString(event.content.id, "content.id")),
		"content:afterRestore": (event, ctx) =>
			recordContentAction(ctx, "restore", requiredString(event.content.id, "content.id")),
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
		"comment:beforeCreate": async (event, ctx) => {
			await record(ctx, "events", "comment-before-create", {
				collection: event.comment.collection,
			});
			return {
				...event,
				metadata: { ...event.metadata, registryTest: true },
			};
		},
		"comment:moderate": {
			exclusive: true,
			handler: async (event, ctx) => {
				await record(ctx, "events", "comment-moderate", {
					priorApprovedCount: event.priorApprovedCount,
				});
				return { status: "pending", reason: "Registry fixture moderation" };
			},
		},
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
					await ctx.comments.setStatus(event.comment.id, "spam", {
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
		"email:beforeSend": async (event, ctx) => {
			await record(ctx, "events", "email-before-send", { source: event.source });
			return event.message;
		},
		"email:deliver": {
			exclusive: true,
			handler: async (event, ctx) => {
				await record(ctx, "events", "email-deliver", {
					source: event.source,
					to: event.message.to,
				});
			},
		},
		"email:afterSend": {
			errorPolicy: "continue",
			handler: async (event, ctx) =>
				record(ctx, "events", "email-after-send", { source: event.source }),
		},
		"page:metadata": async (event) => [
			{ kind: "meta", name: "emdash-plugin", content: "marketplace-test" },
			{
				kind: "jsonld",
				id: "marketplace-test",
				graph: { "@context": "https://schema.org", "@type": "WebPage", url: event.page.url },
			},
		],
		"page:fragments": async () => [
			{
				kind: "html",
				placement: "body:end",
				html: "<p>This trusted-only contribution must never reach a sandboxed page.</p>",
			},
		],
	},
	routes: {
		admin: {
			permission: "plugins:manage",
			handler: async (route, ctx) => {
				const actionId =
					typeof route.input === "object" &&
					route.input !== null &&
					"action_id" in route.input &&
					typeof route.input.action_id === "string"
						? route.input.action_id
						: undefined;
				if (actionId === "oversized-response") {
					return { blocks: Array.from({ length: 1_001 }, () => ({ type: "divider" })) };
				}
				if (actionId === "unsafe-image") {
					return {
						blocks: [{ type: "image", url: "http://tracker.example/pixel.gif", alt: "" }],
					};
				}
				const page =
					typeof route.input === "object" &&
					route.input !== null &&
					"page" in route.input &&
					typeof route.input.page === "string"
						? route.input.page
						: "/overview";
				if (page === "/components") {
					return {
						blocks: [
							{ type: "header", text: "Block Kit kitchen sink" },
							{
								type: "section",
								text: "Every supported admin-page block and form element is represented here.",
								accessory: { type: "button", label: "Refresh", action_id: "refresh" },
							},
							{ type: "divider" },
							{
								type: "fields",
								fields: [
									{ label: "Locale", value: route.ui?.locale ?? "missing" },
									{ label: "Direction", value: route.ui?.direction ?? "missing" },
								],
							},
							{
								type: "table",
								columns: [
									{ key: "surface", label: "Surface" },
									{ key: "status", label: "Status" },
								],
								rows: [{ surface: "sandbox", status: "ready" }],
								page_action_id: "page-components",
								empty_text: "No diagnostics",
							},
							{
								type: "actions",
								elements: [
									{ type: "button", label: "Run", action_id: "run", style: "primary" },
									{
										type: "link",
										label: "Diagnostics",
										target: { kind: "plugin-page", path: "/overview" },
									},
								],
							},
							{
								type: "stats",
								items: [
									{ label: "Capabilities", value: "24", trend: "up", description: "maximal" },
									{ label: "Runner", value: "isolated", trend: "neutral" },
								],
							},
							{
								type: "form",
								block_id: "component-form",
								fields: [
									{ type: "text_input", action_id: "text", label: "Text" },
									{ type: "number_input", action_id: "number", label: "Number", min: 0, max: 10 },
									{
										type: "select",
										action_id: "select",
										label: "Select",
										options: [{ label: "One", value: "one" }],
									},
									{ type: "toggle", action_id: "toggle", label: "Toggle", initial_value: true },
									{ type: "secret_input", action_id: "secret", label: "Secret" },
									{
										type: "checkbox",
										action_id: "checkbox",
										label: "Checkbox",
										options: [{ label: "One", value: "one" }],
									},
									{
										type: "radio",
										action_id: "radio",
										label: "Radio",
										options: [{ label: "One", value: "one" }],
									},
									{ type: "date_input", action_id: "date", label: "Date" },
									{
										type: "combobox",
										action_id: "combobox",
										label: "Combobox",
										options: [{ label: "One", value: "one" }],
									},
								],
								submit: { action_id: "submit-components", label: "Submit" },
							},
							{ type: "image", url: "/plugin-assets/status.png", alt: "Fixture status" },
							{ type: "context", text: "Rendered by the host" },
							{
								type: "columns",
								columns: [
									[{ type: "meter", label: "Coverage", value: 100 }],
									[{ type: "banner", title: "Deterministic", variant: "default" }],
								],
							},
							{
								type: "chart",
								config: {
									chart_type: "timeseries",
									series: [
										{
											name: "Checks",
											data: [
												[0, 1],
												[1, 2],
											],
										},
									],
									height: 200,
								},
							},
							{ type: "code", code: "export default 'sandbox';", language: "ts" },
							{ type: "meter", label: "Authority", value: 100, custom_value: "maximal" },
							{
								type: "banner",
								title: "Fixture only",
								description: "Not a product",
								variant: "alert",
							},
							{
								type: "empty",
								title: "No failures",
								description: "Run a diagnostic to populate this state.",
								actions: [{ type: "button", action_id: "run-empty", label: "Run" }],
							},
							{
								type: "accordion",
								label: "Runtime context",
								blocks: [{ type: "context", text: route.ui?.surface ?? "missing" }],
							},
							{
								type: "tab",
								panels: [{ label: "Context", blocks: [{ type: "context", text: "Tab panel" }] }],
							},
						],
					};
				}
				return {
					blocks: [
						{ type: "header", text: "Registry diagnostics" },
						{
							type: "context",
							text: "This fixture intentionally requests the maximum compatible sandbox authority.",
						},
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
								{ type: "button", label: "Run diagnostics", action_id: "run-diagnostics" },
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
						{
							type: "image",
							url: `/_emdash/api/plugins/${encodeURIComponent(ctx.plugin.id)}/fixture-image`,
							alt: "Plugin status",
						},
					],
					...(actionId === "run-diagnostics" && {
						toast: { type: "success", message: "Diagnostics passed" },
					}),
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
				const result = await ctx.content.list("posts");
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
				return ctx.media.get(route.input.id);
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
				const result = await ctx.media.readBytes(route.input.id, { maxBytes });
				return { ...result, bytes: [...result.bytes] };
			},
		},
		"media-update-alt": {
			handler: async (route, ctx) => {
				if (!isRecord(route.input)) {
					throw new Error("Expected a media ID and alt text");
				}
				const id = optionalString(route.input, "id");
				const alt = optionalNullableString(route.input, "alt");
				if (id === undefined || alt === undefined) {
					throw new Error("Expected a media ID and alt text");
				}
				return ctx.media.updateMetadata(id, { alt });
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
					comment: await ctx.comments.get(route.input.id),
					page: await ctx.comments.list({ limit: 1 }),
					count: await ctx.comments.count(),
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
					return await ctx.comments.setStatus(id, status, { expectedStatus });
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
					await ctx.comments.setStatus(route.input.id, "trash", {
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
				return ctx.taxonomies.createTerm(route.input.taxonomy, { label: route.input.label });
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
				return ctx.taxonomies.addEntryTerms(
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
				return ctx.taxonomies.removeEntryTerms(
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
						return await ctx.redirects.list(redirectListOptions(input.options ?? {}));
					}
					if (operation === "get") {
						return await ctx.redirects.get(requiredString(input.id, "id"));
					}
					if (operation === "create") {
						return await ctx.redirects.create(redirectCreateInput(input.redirect));
					}
					if (operation === "update") {
						return await ctx.redirects.update(
							requiredString(input.id, "id"),
							redirectUpdateInput(input.redirect),
						);
					}
					if (operation === "delete") {
						return {
							deleted: await ctx.redirects.delete(requiredString(input.id, "id"), {
								_rev: requiredString(input._rev, "_rev"),
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
					schema: await ctx.schema.getCollection("posts"),
					item: await ctx.content.get("posts", id),
					translations: await ctx.content.getTranslations("posts", id),
					publicUrl: await ctx.content.getPublicUrl("posts", id),
					revisions: await ctx.content.listRevisions("posts", id),
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
					list: await ctx.content.listRevisions("posts", route.input.id),
					item: await ctx.content.getRevision("posts", route.input.id, route.input.revisionId),
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
					return ctx.content.getTrashedVersioned(collection, id);
				}
				if (action === "getVersioned") return ctx.content.getVersioned(collection, id);
				if (!("_rev" in input) || typeof input._rev !== "string") {
					throw new Error("Expected _rev");
				}
				if (action === "publish") {
					try {
						return await ctx.content.publish(collection, id, { _rev: input._rev });
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
					return ctx.content.unpublish(collection, id, { _rev: input._rev });
				}
				if (action === "schedule") {
					if (!("scheduledAt" in input) || typeof input.scheduledAt !== "string") {
						throw new Error("Expected scheduledAt");
					}
					return ctx.content.schedule(collection, id, {
						scheduledAt: input.scheduledAt,
						_rev: input._rev,
					});
				}
				if (action === "unschedule") {
					return ctx.content.unschedule(collection, id, { _rev: input._rev });
				}
				if (action === "restore") return ctx.content.restore(collection, id, { _rev: input._rev });
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
				await ctx.cron.schedule(name, { schedule: at });
				return { scheduled: true };
			},
		},
		"send-email": {
			handler: async (_route, ctx) => {
				await ctx.email.send({
					to: "author@example.com",
					subject: "Runtime host",
					text: "Captured by the test host",
				});
				return { sent: true };
			},
		},
		"storage-exercise": {
			permission: "plugins:manage",
			handler: async (_route, ctx) => {
				const records = ctx.storage.records;
				await records.deleteMany(["one", "two", "three", "cas"]);
				await records.put("one", { externalId: "ext-one", status: "pending", score: 1 });
				await records.putMany([
					{ id: "two", data: { externalId: "ext-two", status: "pending", score: 2 } },
					{ id: "three", data: { externalId: "ext-three", status: "done", score: 3 } },
				]);
				const created = await records.compareAndSet("cas", null, {
					externalId: "ext-cas",
					status: "pending",
					score: 4,
				});
				if (!created.applied) throw new Error("CAS fixture creation failed");
				const replaced = await records.compareAndSet("cas", created.revision, {
					externalId: "ext-cas",
					status: "processing",
					score: 5,
				});
				const stale = await records.compareAndSet("cas", created.revision, {
					externalId: "ext-cas",
					status: "lost",
					score: 0,
				});
				const guarded = await records.updateIf("one", {
					where: { status: "pending", score: { gte: 1 } },
					set: { status: "processing" },
					delta: { score: { inc: 1 } },
				});
				const many = await records.getMany(["one", "two", "missing"]);
				const page = await records.query({
					where: { status: { in: ["pending", "processing"] } },
					orderBy: { score: "asc" },
					limit: 2,
				});
				const count = await records.count({ status: { in: ["pending", "processing"] } });
				const removed = await records.compareAndDelete(
					"cas",
					replaced.applied ? replaced.revision : created.revision,
				);
				return {
					exists: await records.exists("one"),
					one: await records.get("one"),
					many: [...many.entries()],
					page,
					count,
					guarded,
					staleApplied: stale.applied,
					removed: removed.applied,
					deletedMany: await records.deleteMany(["two", "three"]),
				};
			},
		},
		"kv-exercise": {
			permission: "plugins:manage",
			handler: async (_route, ctx) => {
				await ctx.kv.delete("diagnostic:cas");
				await ctx.kv.set("diagnostic:plain", { ok: true });
				const created = await ctx.kv.compareAndSet("diagnostic:cas", null, 1);
				if (!created.applied) throw new Error("KV CAS fixture creation failed");
				const replaced = await ctx.kv.compareAndSet("diagnostic:cas", created.revision, 2);
				const stale = await ctx.kv.compareAndSet("diagnostic:cas", created.revision, 3);
				const current = await ctx.kv.getVersioned<number>("diagnostic:cas");
				const listed = await ctx.kv.list("diagnostic:");
				const removed = await ctx.kv.compareAndDelete(
					"diagnostic:cas",
					replaced.applied ? replaced.revision : created.revision,
				);
				return {
					plain: await ctx.kv.get("diagnostic:plain"),
					current,
					listed,
					staleApplied: stale.applied,
					removed: removed.applied,
				};
			},
		},
		"settings-exercise": {
			permission: "plugins:manage",
			handler: async (_route, ctx) => {
				await ctx.settings.delete("notes");
				const created = await ctx.settings.compareAndSet("notes", null, "first");
				if (!created.applied) throw new Error("Settings CAS fixture creation failed");
				const replaced = await ctx.settings.compareAndSet("notes", created.revision, "second");
				const stale = await ctx.settings.compareAndSet("notes", created.revision, "lost");
				const current = await ctx.settings.getVersioned<string>("notes");
				const listed = await ctx.settings.list();
				const removed = await ctx.settings.compareAndDelete(
					"notes",
					replaced.applied ? replaced.revision : created.revision,
				);
				return { current, listed, staleApplied: stale.applied, removed: removed.applied };
			},
		},
		"schema-exercise": {
			permission: "schema:read",
			handler: async (_route, ctx) => ({
				collections: await ctx.schema.listCollections(),
				posts: await ctx.schema.getCollection("posts"),
			}),
		},
		"users-exercise": {
			permission: "users:manage",
			handler: async (route, ctx) => {
				const input = isRecord(route.input) ? route.input : {};
				return {
					byId: typeof input.id === "string" ? await ctx.users.get(input.id) : null,
					byEmail: typeof input.email === "string" ? await ctx.users.getByEmail(input.email) : null,
					page: await ctx.users.list({ limit: 2 }),
				};
			},
		},
		"taxonomy-read": {
			permission: "content:read",
			handler: async (route, ctx) => {
				const input = isRecord(route.input) ? route.input : {};
				const entryId = typeof input.entryId === "string" ? input.entryId : "missing";
				return {
					definitions: await ctx.taxonomies.getAll(),
					terms: await ctx.taxonomies.getTerms("category"),
					assigned: await ctx.taxonomies.getEntryTerms("posts", entryId, {
						taxonomy: "category",
					}),
				};
			},
		},
		"content-crud": {
			permission: "content:edit_any",
			handler: async (route, ctx) => {
				if (!isRecord(route.input) || typeof route.input.operation !== "string") {
					throw new Error("Expected a content operation");
				}
				const input = route.input;
				if (input.operation === "list") return ctx.content.list("posts", { limit: 2 });
				if (input.operation === "get" && typeof input.id === "string") {
					return ctx.content.get("posts", input.id);
				}
				if (input.operation === "create" && isRecord(input.data)) {
					return ctx.content.create("posts", input.data);
				}
				if (input.operation === "update" && typeof input.id === "string" && isRecord(input.data)) {
					return ctx.content.update("posts", input.id, input.data);
				}
				if (input.operation === "delete" && typeof input.id === "string") {
					return { deleted: await ctx.content.delete("posts", input.id) };
				}
				throw new Error("Invalid content operation");
			},
		},
		"media-exercise": {
			permission: "media:delete_any",
			handler: async (route, ctx) => {
				if (!isRecord(route.input) || typeof route.input.operation !== "string") {
					throw new Error("Expected a media operation");
				}
				const input = route.input;
				if (input.operation === "list") return ctx.media.list({ limit: 2 });
				if (input.operation === "upload") {
					const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
					return ctx.media.upload("fixture.pdf", "application/pdf", bytes.buffer);
				}
				if (typeof input.id !== "string") throw new Error("Expected a media ID");
				if (input.operation === "metadata") {
					return ctx.media.updateMetadata(input.id, {
						alt: "Fixture alt",
						caption: "Fixture caption",
						focalX: 0.25,
						focalY: 0.75,
					});
				}
				if (input.operation === "delete") return { deleted: await ctx.media.delete(input.id) };
				throw new Error("Invalid media operation");
			},
		},
		"cron-exercise": {
			permission: "plugins:manage",
			handler: async (_route, ctx) => {
				await ctx.cron.schedule("diagnostic", { schedule: "0 0 * * *", data: { fixture: true } });
				const scheduled = await ctx.cron.list();
				await ctx.cron.cancel("diagnostic");
				return { scheduled, remaining: await ctx.cron.list() };
			},
		},
		diagnostics: {
			permission: "plugins:manage",
			handler: async (_route, ctx) => ({
				plugin: ctx.plugin,
				site: ctx.site,
				absoluteUrl: ctx.url("/diagnostics"),
				eventCount: await ctx.storage.events.count(),
				scheduled: await ctx.cron.list(),
				authority: {
					content: ctx.content !== undefined,
					schema: ctx.schema !== undefined,
					taxonomies: ctx.taxonomies !== undefined,
					redirects: ctx.redirects !== undefined,
					media: ctx.media !== undefined,
					http: ctx.http !== undefined,
					users: ctx.users !== undefined,
					comments: ctx.comments !== undefined,
					email: ctx.email !== undefined,
				},
			}),
		},
		"records/delete": pluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 },
			handler: async (route, ctx) => {
				if (!isRecord(route.input) || typeof route.input.id !== "string" || !route.input.id) {
					throw new Error("Expected a record ID");
				}
				return { deleted: await ctx.storage.records.delete(route.input.id) };
			},
		}),
		"logging-exercise": {
			permission: "plugins:manage",
			handler: async (_route, ctx) => {
				ctx.log.debug("registry fixture debug", { secret: "[redacted]" });
				ctx.log.info("registry fixture info");
				ctx.log.warn("registry fixture warning");
				ctx.log.error("registry fixture error");
				return { logged: true };
			},
		},
		"all-methods": pluginRoute({
			public: true,
			methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
			request: { body: "none" },
			handler: async (route) => ({ method: route.request.method }),
		}),
		"body-none": pluginRoute({
			public: true,
			methods: ["GET", "HEAD"],
			request: { body: "none" },
			handler: async (route) => ({ method: route.request.method, input: route.input }),
		}),
		"body-json": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 2048 },
			handler: async (route) => ({ input: route.input }),
		}),
		"body-text": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "text", maxBytes: 2048 },
			handler: async (route) => ({ text: route.input, length: route.input.length }),
		}),
		"body-bytes": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "bytes", maxBytes: 2048 },
			handler: async (route) => ({ bytes: [...route.input] }),
		}),
		"raw-text": pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			cacheControl: "public, max-age=60",
			handler: async () =>
				pluginResponse({
					status: 200,
					headers: { "content-type": "text/plain; charset=utf-8", etag: '"fixture"' },
					body: { kind: "text", value: "marketplace-test" },
				}),
		}),
		"fixture-image": pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			cacheControl: "public, max-age=3600",
			handler: async () =>
				pluginResponse({
					status: 200,
					headers: { "content-type": "image/png" },
					body: { kind: "bytes", value: fixturePng },
				}),
		}),
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
				const response = await ctx.http.fetch(route.input.url, {
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
	mcp: {
		tools: {
			runDiagnostics: {
				description: "Read the registry fixture diagnostic summary.",
				route: "diagnostics",
				input: diagnosticsMcpInput,
				output: diagnosticsMcpOutput,
				destructive: false,
			},
			deleteRecord: {
				description: "Delete one registry fixture storage record.",
				route: "records/delete",
				input: deleteRecordMcpInput,
				output: deleteRecordMcpOutput,
				destructive: true,
			},
		},
	},
};

export default plugin;
