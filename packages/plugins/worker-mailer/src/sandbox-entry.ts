/**
 * Sandbox Entry Point -- Worker Mailer SMTP
 *
 * Standard-format runtime entry for isolated / marketplace-style use.
 * Configuration comes from plugin KV settings and Block Kit admin pages.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import {
	DEFAULT_AUTH_TYPE,
	DEFAULT_SECURE_PORT,
	SECURE_CONNECTION_MESSAGE,
	createWorkerMailerHooks,
} from "./shared.js";

interface AdminInteraction {
	type: string;
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

export default definePlugin({
	hooks: createWorkerMailerHooks(),
	routes: {
		admin: {
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const interaction = (routeCtx.input ?? {}) as AdminInteraction;

				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsPage(ctx);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}

				return { blocks: [] };
			},
		},
	},
});

function toNonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function toPortNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

async function buildSettingsPage(ctx: PluginContext) {
	const host = (await ctx.kv.get<string>("settings:host")) ?? "";
	const username = (await ctx.kv.get<string>("settings:username")) ?? "";
	const fromEmail = (await ctx.kv.get<string>("settings:fromEmail")) ?? "";
	const fromName = (await ctx.kv.get<string>("settings:fromName")) ?? "";
	const authType = (await ctx.kv.get<string>("settings:authType")) ?? DEFAULT_AUTH_TYPE;
	const port = toPortNumber(
		await ctx.kv.get<number | string>("settings:port"),
		DEFAULT_SECURE_PORT,
	);
	const hasPassword = !!(await ctx.kv.get<string>("settings:password"));

	return {
		blocks: [
			{ type: "header", text: "SMTP Settings" },
			{
				type: "context",
				text: "Configure Worker Mailer for isolated SMTP delivery with Block Kit settings.",
			},
			{
				type: "fields",
				fields: [
					{ label: "Connection", value: "Implicit TLS / SMTPS" },
					{ label: "Port", value: String(port) },
					{ label: "Host", value: host || "Not configured" },
					{ label: "Password", value: hasPassword ? "Stored" : "Not set" },
				],
			},
			{ type: "divider" },
			{
				type: "form",
				block_id: "worker-mailer-settings",
				fields: [
					{
						type: "text_input",
						action_id: "host",
						label: "SMTP Host",
						initial_value: host,
					},
					{
						type: "number_input",
						action_id: "port",
						label: "SMTP Port",
						initial_value: port,
						min: 1,
						max: 65535,
					},
					{
						type: "select",
						action_id: "authType",
						label: "Auth Type",
						options: [
							{ label: "PLAIN", value: "plain" },
							{ label: "LOGIN", value: "login" },
							{ label: "CRAM-MD5", value: "cram-md5" },
						],
						initial_value: authType,
					},
					{
						type: "text_input",
						action_id: "username",
						label: "SMTP Username",
						initial_value: username,
					},
					{
						type: "secret_input",
						action_id: "password",
						label: "SMTP Password",
					},
					{
						type: "text_input",
						action_id: "fromEmail",
						label: "From Email",
						initial_value: fromEmail,
					},
					{
						type: "text_input",
						action_id: "fromName",
						label: "From Name",
						initial_value: fromName,
					},
				],
				submit: { label: "Save Settings", action_id: "save_settings" },
			},
			{
				type: "context",
				text:
					`${SECURE_CONNECTION_MESSAGE} ` +
					"Leave From Email blank to fall back to the SMTP username. " +
					"Leave Password blank to keep the stored secret.",
			},
		],
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	const port = toPortNumber(values.port, DEFAULT_SECURE_PORT);

	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Port must be between 1 and 65535", type: "error" },
		};
	}

	await ctx.kv.delete("settings:transportSecurity");
	await ctx.kv.delete("settings:transportSecurityMode");
	await ctx.kv.delete("settings:startTls");
	await ctx.kv.delete("settings:secure");
	await ctx.kv.set("settings:port", port);
	await ctx.kv.set("settings:authType", toNonEmpty(values.authType) ?? DEFAULT_AUTH_TYPE);

	const host = toNonEmpty(values.host);
	if (host) {
		await ctx.kv.set("settings:host", host);
	} else {
		await ctx.kv.delete("settings:host");
	}

	const username = toNonEmpty(values.username);
	if (username) {
		await ctx.kv.set("settings:username", username);
	} else {
		await ctx.kv.delete("settings:username");
	}

	const password = toNonEmpty(values.password);
	if (password) {
		await ctx.kv.set("settings:password", password);
	}

	const fromEmail = toNonEmpty(values.fromEmail);
	if (fromEmail) {
		await ctx.kv.set("settings:fromEmail", fromEmail);
	} else {
		await ctx.kv.delete("settings:fromEmail");
	}

	const fromName = toNonEmpty(values.fromName);
	if (fromName) {
		await ctx.kv.set("settings:fromName", fromName);
	} else {
		await ctx.kv.delete("settings:fromName");
	}

	return {
		...(await buildSettingsPage(ctx)),
		toast: { message: "Settings saved", type: "success" },
	};
}
