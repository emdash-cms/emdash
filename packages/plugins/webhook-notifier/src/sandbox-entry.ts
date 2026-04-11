/**
 * Sandbox Entry Point -- Webhook Notifier
 *
 * Canonical plugin implementation using the standard format.
 * Runs in both trusted (in-process) and sandboxed (isolate) modes.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

interface ContentSaveEvent {
	content: Record<string, unknown>;
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

interface WebhookPayload {
	event: string;
	timestamp: string;
	collection?: string;
	resourceId: string;
	resourceType: "content" | "media";
	data?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

// ── SSRF protection ──

const IPV6_BRACKET_PATTERN = /^\[|\]$/g;
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "[::1]"]);
const PRIVATE_RANGES = [
	{ start: (127 << 24) >>> 0, end: ((127 << 24) | 0x00ffffff) >>> 0 },
	{ start: (10 << 24) >>> 0, end: ((10 << 24) | 0x00ffffff) >>> 0 },
	{
		start: ((172 << 24) | (16 << 16)) >>> 0,
		end: ((172 << 24) | (31 << 16) | 0xffff) >>> 0,
	},
	{
		start: ((192 << 24) | (168 << 16)) >>> 0,
		end: ((192 << 24) | (168 << 16) | 0xffff) >>> 0,
	},
	{
		start: ((169 << 24) | (254 << 16)) >>> 0,
		end: ((169 << 24) | (254 << 16) | 0xffff) >>> 0,
	},
	{ start: 0, end: 0x00ffffff },
];

function validateWebhookUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid webhook URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Webhook URL scheme '${parsed.protocol}' is not allowed`);
	}
	const hostname = parsed.hostname.replace(IPV6_BRACKET_PATTERN, "");
	if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
		throw new Error("Webhook URLs targeting internal hosts are not allowed");
	}
	const parts = hostname.split(".");
	if (parts.length === 4) {
		const nums = parts.map(Number);
		if (nums.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
			const ip = ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0;
			if (PRIVATE_RANGES.some((r) => ip >= r.start && ip <= r.end)) {
				throw new Error("Webhook URLs targeting private IP addresses are not allowed");
			}
		}
	}
	if (
		hostname === "::1" ||
		hostname.startsWith("fe80:") ||
		hostname.startsWith("fc") ||
		hostname.startsWith("fd")
	) {
		throw new Error("Webhook URLs targeting internal addresses are not allowed");
	}
}

// ── Webhook delivery ──

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type LogFn = PluginContext["log"];

async function sendWebhook(
	fetchFn: FetchFn,
	log: LogFn,
	url: string,
	payload: WebhookPayload,
	token: string | undefined,
	maxRetries: number,
): Promise<{ success: boolean; status?: number; error?: string }> {
	validateWebhookUrl(url);

	let lastError: string | undefined;
	let lastStatus: number | undefined;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"X-EmDash-Event": payload.event,
			};
			if (token) headers["Authorization"] = `Bearer ${token}`;

			const response = await fetchFn(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
			});

			lastStatus = response.status;
			if (response.ok) {
				log.info(`Delivered ${payload.event} to ${url} (${response.status})`);
				return { success: true, status: response.status };
			}

			lastError = `HTTP ${response.status}: ${response.statusText}`;
			log.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError}`);
		} catch (error) {
			lastError = error instanceof Error ? error.message : "Unknown error";
			log.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError}`);
		}

		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
		}
	}

	log.error(`Failed to deliver ${payload.event} after ${maxRetries} attempts`);
	return { success: false, status: lastStatus, error: lastError };
}

// ── Helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const v = value[key];
	return typeof v === "string" ? v : undefined;
}

const MAX_RETRIES = 3;

async function getConfig(ctx: PluginContext) {
	const url = await ctx.kv.get<string>("settings:webhookUrl");
	const token = await ctx.kv.get<string>("settings:secretToken");
	const enabled = await ctx.kv.get<boolean>("settings:enabled");
	return { url, token, enabled };
}

function getFetchFn(ctx: PluginContext): FetchFn {
	if (!ctx.http) {
		throw new Error("Webhook notifier requires network:fetch capability");
	}
	return ctx.http.fetch;
}

// ── Plugin definition ──

export default definePlugin({
	hooks: {
		"content:afterSave": {
			priority: 210,
			timeout: 10000,
			dependencies: ["audit-log"],
			errorPolicy: "continue",
			handler: async (event: ContentSaveEvent, ctx: PluginContext) => {
				const { url, token, enabled } = await getConfig(ctx);
				if (enabled === false || !url) return;

				const contentId =
					typeof event.content.id === "string" ? event.content.id : String(event.content.id);

				const payload: WebhookPayload = {
					event: event.isNew ? "content:create" : "content:update",
					timestamp: new Date().toISOString(),
					collection: event.collection,
					resourceId: contentId,
					resourceType: "content",
					metadata: {
						slug: event.content.slug,
						status: event.content.status,
					},
				};

				await sendWebhook(getFetchFn(ctx), ctx.log, url, payload, token ?? undefined, MAX_RETRIES);
			},
		},

		"content:afterDelete": {
			priority: 210,
			timeout: 10000,
			dependencies: ["audit-log"],
			errorPolicy: "continue",
			handler: async (event: ContentDeleteEvent, ctx: PluginContext) => {
				const { url, token, enabled } = await getConfig(ctx);
				if (enabled === false || !url) return;

				const payload: WebhookPayload = {
					event: "content:delete",
					timestamp: new Date().toISOString(),
					collection: event.collection,
					resourceId: event.id,
					resourceType: "content",
				};

				await sendWebhook(getFetchFn(ctx), ctx.log, url, payload, token ?? undefined, MAX_RETRIES);
			},
		},

		"media:afterUpload": {
			priority: 210,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event: MediaUploadEvent, ctx: PluginContext) => {
				const { url, token, enabled } = await getConfig(ctx);
				if (enabled === false || !url) return;

				const payload: WebhookPayload = {
					event: "media:upload",
					timestamp: new Date().toISOString(),
					resourceId: event.media.id,
					resourceType: "media",
				};

				await sendWebhook(getFetchFn(ctx), ctx.log, url, payload, token ?? undefined, MAX_RETRIES);
			},
		},
	},

	routes: {
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
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" && interaction.page === "widget:webhook-status") {
					return buildStatusWidget(ctx);
				}
				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsPage(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}
				if (interaction.type === "block_action" && interaction.action_id === "test_webhook") {
					return testWebhook(ctx);
				}
				return { blocks: [] };
			},
		},

		status: {
			handler: async (_routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				try {
					const url = await ctx.kv.get<string>("settings:webhookUrl");
					const enabled = await ctx.kv.get<boolean>("settings:enabled");
					const deliveries = ctx.storage.deliveries!;
					const successful = await deliveries.count({ status: "success" });
					const failed = await deliveries.count({ status: "failed" });
					const pending = await deliveries.count({ status: "pending" });

					return {
						configured: !!url,
						enabled: enabled ?? true,
						stats: { successful, failed, pending },
					};
				} catch (error) {
					ctx.log.error("Failed to get status", error);
					return {
						configured: false,
						enabled: true,
						stats: { successful: 0, failed: 0, pending: 0 },
					};
				}
			},
		},

		settings: {
			handler: async (_routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				try {
					const settings = await ctx.kv.list("settings:");
					const map: Record<string, unknown> = {};
					for (const entry of settings) {
						map[entry.key.replace("settings:", "")] = entry.value;
					}
					return {
						webhookUrl: typeof map.webhookUrl === "string" ? map.webhookUrl : "",
						enabled: typeof map.enabled === "boolean" ? map.enabled : true,
						includeData: typeof map.includeData === "boolean" ? map.includeData : false,
						events: typeof map.events === "string" ? map.events : "all",
					};
				} catch (error) {
					ctx.log.error("Failed to get settings", error);
					return { webhookUrl: "", enabled: true, includeData: false, events: "all" };
				}
			},
		},

		"settings/save": {
			handler: async (routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				try {
					const input = isRecord(routeCtx.input) ? routeCtx.input : {};
					if (typeof input.webhookUrl === "string")
						await ctx.kv.set("settings:webhookUrl", input.webhookUrl);
					if (typeof input.enabled === "boolean")
						await ctx.kv.set("settings:enabled", input.enabled);
					if (typeof input.includeData === "boolean")
						await ctx.kv.set("settings:includeData", input.includeData);
					if (typeof input.events === "string") await ctx.kv.set("settings:events", input.events);
					return { success: true };
				} catch (error) {
					ctx.log.error("Failed to save settings", error);
					return { success: false, error: String(error) };
				}
			},
		},

		test: {
			handler: async (routeCtx: { input: unknown; request: unknown }, ctx: PluginContext) => {
				const testUrl = getString(routeCtx.input, "url");
				if (!testUrl) return { success: false, error: "No webhook URL provided" };

				const token = await ctx.kv.get<string>("settings:secretToken");

				const testPayload: WebhookPayload = {
					event: "content:create",
					timestamp: new Date().toISOString(),
					resourceId: "test-" + Date.now(),
					resourceType: "content",
					metadata: { test: true, message: "Webhook test from EmDash CMS" },
				};

				const result = await sendWebhook(
					getFetchFn(ctx),
					ctx.log,
					testUrl,
					testPayload,
					token ?? undefined,
					1,
				);
				return {
					success: result.success,
					status: result.status,
					error: result.error,
					payload: testPayload,
				};
			},
		},
	},
});

// ── Block Kit admin helpers ──

async function buildStatusWidget(ctx: PluginContext) {
	try {
		const url = await ctx.kv.get<string>("settings:webhookUrl");
		const enabled = await ctx.kv.get<boolean>("settings:enabled");
		const isConfigured = !!url && enabled !== false;

		let successful = 0;
		let failed = 0;
		let pending = 0;
		try {
			const deliveries = ctx.storage.deliveries!;
			successful = await deliveries.count({ status: "success" });
			failed = await deliveries.count({ status: "failed" });
			pending = await deliveries.count({ status: "pending" });
		} catch {
			// Storage not available yet
		}

		const blocks: unknown[] = [
			{
				type: "fields",
				fields: [
					{
						label: "Status",
						value: isConfigured ? "Active" : "Not Configured",
					},
					{
						label: "Endpoint",
						value: url ? url : "None",
					},
				],
			},
		];

		if (isConfigured) {
			blocks.push({
				type: "stats",
				stats: [
					{ label: "Delivered", value: String(successful) },
					{ label: "Failed", value: String(failed) },
					{ label: "Pending", value: String(pending) },
				],
			});
		} else {
			blocks.push({
				type: "context",
				text: "Configure a webhook URL in settings to start sending events.",
			});
		}

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build status widget", error);
		return { blocks: [{ type: "context", text: "Failed to load webhook status" }] };
	}
}

async function buildSettingsPage(ctx: PluginContext) {
	try {
		const webhookUrl = (await ctx.kv.get<string>("settings:webhookUrl")) ?? "";
		const enabled = (await ctx.kv.get<boolean>("settings:enabled")) ?? true;
		const includeData = (await ctx.kv.get<boolean>("settings:includeData")) ?? false;
		const events = (await ctx.kv.get<string>("settings:events")) ?? "all";

		const payloadPreview = JSON.stringify(
			{
				event: "content:create",
				timestamp: new Date().toISOString(),
				collection: "posts",
				resourceId: "abc123",
				resourceType: "content",
				...(includeData && {
					data: { title: "Example Post", slug: "example-post" },
				}),
				metadata: { slug: "example-post", status: "published" },
			},
			null,
			2,
		);

		return {
			blocks: [
				{ type: "header", text: "Webhook Settings" },
				{
					type: "context",
					text: "Send notifications to external services when content changes.",
				},
				{ type: "divider" },
				{
					type: "form",
					block_id: "webhook-settings",
					fields: [
						{
							type: "text_input",
							action_id: "webhookUrl",
							label: "Webhook URL",
							initial_value: webhookUrl,
						},
						{
							type: "secret_input",
							action_id: "secretToken",
							label: "Secret Token",
						},
						{
							type: "toggle",
							action_id: "enabled",
							label: "Enable Webhooks",
							initial_value: enabled,
						},
						{
							type: "select",
							action_id: "events",
							label: "Events to Send",
							options: [
								{ label: "All events", value: "all" },
								{ label: "Content changes only", value: "content" },
								{ label: "Media uploads only", value: "media" },
							],
							initial_value: events,
						},
						{
							type: "toggle",
							action_id: "includeData",
							label: "Include Content Data",
							initial_value: includeData,
						},
					],
					submit: { label: "Save Settings", action_id: "save_settings" },
				},
				{ type: "divider" },
				{ type: "section", text: "**Payload Preview**" },
				{ type: "section", text: "```json\n" + payloadPreview + "\n```" },
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: "Test Webhook",
							action_id: "test_webhook",
							style: "primary",
						},
					],
				},
			],
		};
	} catch (error) {
		ctx.log.error("Failed to build settings page", error);
		return { blocks: [{ type: "context", text: "Failed to load settings" }] };
	}
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	try {
		if (typeof values.webhookUrl === "string")
			await ctx.kv.set("settings:webhookUrl", values.webhookUrl);
		if (typeof values.secretToken === "string" && values.secretToken !== "")
			await ctx.kv.set("settings:secretToken", values.secretToken);
		if (typeof values.enabled === "boolean") await ctx.kv.set("settings:enabled", values.enabled);
		if (typeof values.events === "string") await ctx.kv.set("settings:events", values.events);
		if (typeof values.includeData === "boolean")
			await ctx.kv.set("settings:includeData", values.includeData);

		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Settings saved", type: "success" },
		};
	} catch (error) {
		ctx.log.error("Failed to save settings", error);
		return {
			blocks: [{ type: "banner", style: "error", text: "Failed to save settings" }],
			toast: { message: "Failed to save settings", type: "error" },
		};
	}
}

async function testWebhook(ctx: PluginContext) {
	const url = await ctx.kv.get<string>("settings:webhookUrl");
	if (!url) {
		return {
			blocks: [{ type: "banner", style: "warning", text: "Enter a webhook URL first." }],
			toast: { message: "No webhook URL configured", type: "error" },
		};
	}

	const token = await ctx.kv.get<string>("settings:secretToken");
	const testPayload: WebhookPayload = {
		event: "content:create",
		timestamp: new Date().toISOString(),
		resourceId: "test-" + Date.now(),
		resourceType: "content",
		metadata: { test: true, message: "Webhook test from EmDash CMS" },
	};

	try {
		const result = await sendWebhook(
			getFetchFn(ctx),
			ctx.log,
			url,
			testPayload,
			token ?? undefined,
			1,
		);

		if (result.success) {
			return {
				...(await buildSettingsPage(ctx)),
				toast: { message: `Test sent -- HTTP ${result.status}`, type: "success" },
			};
		}
		return {
			...(await buildSettingsPage(ctx)),
			toast: {
				message: `Test failed: ${result.error ?? "Unknown error"}`,
				type: "error",
			},
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: `Test failed: ${msg}`, type: "error" },
		};
	}
}
