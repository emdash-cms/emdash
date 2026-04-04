/**
 * Worker Mailer Plugin for EmDash CMS
 *
 * Provides an `email:deliver` transport implementation using
 * `@ribassu/worker-mailer` for Cloudflare Workers.
 *
 * Cloudflare Workers only supports SMTP connections that start secure
 * (implicit TLS / SMTPS). STARTTLS upgrades from plaintext are not supported.
 */

import type { EmailOptions, WorkerMailerOptions } from "@ribassu/worker-mailer";
import { definePlugin } from "emdash";
import type { PluginContext, PluginDescriptor, ResolvedPlugin } from "emdash";

const PLUGIN_ID = "worker-mailer";
const VERSION = "0.1.0";
const DEFAULT_PORT = 465;
const DEFAULT_AUTH_TYPE = "plain";
const IMPLICIT_TLS_REQUIRED_MESSAGE =
	"Cloudflare Workers only supports SMTP connections that start secure (implicit TLS / SMTPS). Use a TLS-enabled SMTP port such as 465.";

const VALID_AUTH_TYPES = new Set(["plain", "login", "cram-md5"] as const);

type AuthType = "plain" | "login" | "cram-md5";

export interface WorkerMailerPluginOptions {
	/** SMTP host (e.g. smtp.example.com) */
	host?: string;
	/** SMTP port for an implicit TLS endpoint (e.g. 465) */
	port?: number;
	/** Only `true` is supported on Cloudflare Workers */
	secure?: boolean;
	/** SMTP auth type */
	authType?: AuthType;
	/** SMTP username */
	username?: string;
	/** SMTP password */
	password?: string;
	/** Optional sender email override (defaults to username) */
	fromEmail?: string;
	/** Optional sender display name */
	fromName?: string;
}

interface WorkerMailerConfig {
	host: string;
	port: number;
	authType: AuthType;
	username: string;
	password: string;
	fromEmail: string;
	fromName: string | undefined;
}

/**
 * Descriptor for use in astro.config.mjs / live.config.ts.
 */
export function workerMailerPlugin(
	options: WorkerMailerPluginOptions = {},
): PluginDescriptor<WorkerMailerPluginOptions> {
	return {
		id: PLUGIN_ID,
		version: VERSION,
		entrypoint: "@emdash-cms/plugin-worker-mailer",
		options,
		capabilities: ["email:provide"],
		adminPages: [{ path: "/settings", label: "SMTP", icon: "envelope" }],
	};
}

function coerceAuthType(value: unknown, fallback: AuthType): AuthType {
	if (typeof value !== "string") return fallback;
	if (VALID_AUTH_TYPES.has(value as AuthType)) return value as AuthType;
	return fallback;
}

function coerceNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function toNonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

async function readConfig(
	ctx: PluginContext,
	options: WorkerMailerPluginOptions,
): Promise<WorkerMailerConfig> {
	const host = toNonEmpty(await ctx.kv.get<string>("settings:host")) ?? toNonEmpty(options.host);
	const port = coerceNumber(
		await ctx.kv.get<number>("settings:port"),
		options.port ?? DEFAULT_PORT,
	);
	const secure = (await ctx.kv.get<boolean>("settings:secure")) ?? options.secure ?? true;
	const authType = coerceAuthType(
		await ctx.kv.get<string>("settings:authType"),
		options.authType ?? DEFAULT_AUTH_TYPE,
	);
	const username =
		toNonEmpty(await ctx.kv.get<string>("settings:username")) ?? toNonEmpty(options.username);
	const password =
		toNonEmpty(await ctx.kv.get<string>("settings:password")) ?? toNonEmpty(options.password);

	const explicitFrom =
		toNonEmpty(await ctx.kv.get<string>("settings:fromEmail")) ?? toNonEmpty(options.fromEmail);
	const fromEmail = explicitFrom ?? username;
	const fromName =
		toNonEmpty(await ctx.kv.get<string>("settings:fromName")) ?? toNonEmpty(options.fromName);

	const missing: string[] = [];
	if (!host) missing.push("host");
	if (!username) missing.push("username");
	if (!password) missing.push("password");
	if (!fromEmail) missing.push("fromEmail (or username)");
	if (!Number.isFinite(port) || port <= 0 || port > 65535) missing.push("port");

	if (missing.length > 0) {
		throw new Error(
			`Worker Mailer is not configured. Missing/invalid setting(s): ${missing.join(", ")}.`,
		);
	}

	if (!secure) {
		throw new Error(
			`Worker Mailer cannot use plaintext SMTP or STARTTLS. ${IMPLICIT_TLS_REQUIRED_MESSAGE}`,
		);
	}

	return {
		host: host!,
		port,
		authType,
		username: username!,
		password: password!,
		fromEmail: fromEmail!,
		fromName,
	};
}

async function setDefault(
	ctx: PluginContext,
	key: string,
	value: string | number | boolean | undefined,
): Promise<void> {
	if (value === undefined) return;
	const existing = await ctx.kv.get<unknown>(key);
	if (existing !== null) return;
	await ctx.kv.set(key, value);
}

async function loadWorkerMailer(): Promise<typeof import("@ribassu/worker-mailer")> {
	try {
		return await import("@ribassu/worker-mailer");
	} catch (error) {
		throw new Error(
			`Failed to load @ribassu/worker-mailer. ` +
				`Ensure this plugin runs on Cloudflare Workers with nodejs_compat enabled.`,
			{ cause: error },
		);
	}
}

async function sendWithWorkerMailer(
	ctx: PluginContext,
	config: WorkerMailerConfig,
	message: { to: string; subject: string; text: string; html?: string },
): Promise<void> {
	const { WorkerMailer } = await loadWorkerMailer();

	const mailerOptions: WorkerMailerOptions = {
		host: config.host,
		port: config.port,
		secure: true,
		authType: config.authType,
		credentials: {
			username: config.username,
			password: config.password,
		},
	};

	const emailOptions: EmailOptions = {
		from: config.fromName ? { name: config.fromName, email: config.fromEmail } : config.fromEmail,
		to: message.to,
		subject: message.subject,
		text: message.text,
		html: message.html,
	};

	await WorkerMailer.send(mailerOptions, emailOptions);

	ctx.log.info(`Delivered email to ${message.to} via Worker Mailer`);
}

export function createPlugin(options: WorkerMailerPluginOptions = {}): ResolvedPlugin {
	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: ["email:provide"],

		hooks: {
			"plugin:install": {
				handler: async (_event, ctx) => {
					await setDefault(ctx, "settings:host", toNonEmpty(options.host));
					await setDefault(ctx, "settings:port", options.port ?? DEFAULT_PORT);
					await ctx.kv.set("settings:secure", true);
					await ctx.kv.delete("settings:startTls");
					await setDefault(ctx, "settings:authType", options.authType ?? DEFAULT_AUTH_TYPE);
					await setDefault(ctx, "settings:username", toNonEmpty(options.username));
					await setDefault(ctx, "settings:password", toNonEmpty(options.password));
					await setDefault(ctx, "settings:fromEmail", toNonEmpty(options.fromEmail));
					await setDefault(ctx, "settings:fromName", toNonEmpty(options.fromName));
				},
			},

			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					const config = await readConfig(ctx, options);
					await sendWithWorkerMailer(ctx, config, event.message);
				},
			},
		},

		admin: {
			settingsSchema: {
				host: {
					type: "string",
					label: "SMTP Host",
					description: "SMTP server hostname for an implicit TLS endpoint (e.g. smtp.example.com)",
					default: options.host ?? "",
				},
				port: {
					type: "number",
					label: "SMTPS Port",
					description: IMPLICIT_TLS_REQUIRED_MESSAGE,
					default: options.port ?? DEFAULT_PORT,
					min: 1,
					max: 65535,
				},
				authType: {
					type: "select",
					label: "Auth Type",
					options: [
						{ value: "plain", label: "PLAIN" },
						{ value: "login", label: "LOGIN" },
						{ value: "cram-md5", label: "CRAM-MD5" },
					],
					default: options.authType ?? DEFAULT_AUTH_TYPE,
				},
				username: {
					type: "string",
					label: "SMTP Username",
					default: options.username ?? "",
				},
				password: {
					type: "secret",
					label: "SMTP Password",
					description: "Stored encrypted at rest",
				},
				fromEmail: {
					type: "string",
					label: "From Email",
					description: "Defaults to SMTP username when empty",
					default: options.fromEmail ?? "",
				},
				fromName: {
					type: "string",
					label: "From Name",
					description: "Optional display name for outgoing emails",
					default: options.fromName ?? "",
				},
			},
			pages: [{ path: "/settings", label: "SMTP", icon: "envelope" }],
		},
	});
}

export default createPlugin;
