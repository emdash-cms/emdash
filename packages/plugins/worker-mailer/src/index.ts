/**
 * Worker Mailer Plugin for EmDash CMS
 *
 * Provides an `email:deliver` transport implementation using
 * `@workermailer/smtp` for Cloudflare Workers.
 *
 * The plugin supports the two secure transport modes available via
 * Cloudflare TCP sockets:
 * - STARTTLS (typically port 587)
 * - Implicit TLS / SMTPS (typically port 465)
 *
 * Plaintext SMTP is intentionally not exposed.
 */

import type { AuthType, EmailOptions, WorkerMailerOptions } from "@workermailer/smtp";
import { definePlugin } from "emdash";
import type { PluginContext, PluginDescriptor, ResolvedPlugin } from "emdash";

const PLUGIN_ID = "worker-mailer";
const VERSION = "0.1.0";
const DEFAULT_TRANSPORT_SECURITY = "starttls";
const DEFAULT_AUTH_TYPE = "plain";
const IMPLICIT_TLS_PORT = 465;
const STARTTLS_PORT = 587;
const TLS_REQUIRED_MESSAGE =
	"Choose STARTTLS on port 587 or implicit TLS on port 465. Plaintext SMTP is not supported.";

type TransportSecurity = "starttls" | "implicit_tls";

function isAuthType(value: string): value is AuthType {
	return value === "plain" || value === "login" || value === "cram-md5";
}

function isTransportSecurity(value: string): value is TransportSecurity {
	return value === "starttls" || value === "implicit_tls";
}

function defaultPortForTransportSecurity(transportSecurity: TransportSecurity): number {
	return transportSecurity === "implicit_tls" ? IMPLICIT_TLS_PORT : STARTTLS_PORT;
}

export interface WorkerMailerPluginOptions {
	/** SMTP host (e.g. smtp.example.com) */
	host?: string;
	/** SMTP port (usually 587 for STARTTLS or 465 for implicit TLS) */
	port?: number;
	/** SMTP transport security mode */
	transportSecurity?: TransportSecurity;
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
	transportSecurity: TransportSecurity;
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

function coerceTransportSecurity(value: unknown, fallback: TransportSecurity): TransportSecurity {
	if (typeof value !== "string") return fallback;
	return isTransportSecurity(value) ? value : fallback;
}

function coerceAuthType(value: unknown, fallback: AuthType): AuthType {
	if (typeof value !== "string") return fallback;
	return isAuthType(value) ? value : fallback;
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
	const transportSecurity = coerceTransportSecurity(
		await ctx.kv.get<string>("settings:transportSecurity"),
		options.transportSecurity ?? DEFAULT_TRANSPORT_SECURITY,
	);
	const host = toNonEmpty(await ctx.kv.get<string>("settings:host")) ?? toNonEmpty(options.host);
	const port = coerceNumber(
		await ctx.kv.get<number>("settings:port"),
		options.port ?? defaultPortForTransportSecurity(transportSecurity),
	);
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

	return {
		host: host!,
		port,
		transportSecurity,
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

async function loadWorkerMailer(): Promise<typeof import("@workermailer/smtp")> {
	try {
		return await import("@workermailer/smtp");
	} catch (error) {
		throw new Error(
			`Failed to load @workermailer/smtp. ` +
				`Ensure this plugin runs on Cloudflare Workers with TCP sockets available.`,
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
		secure: config.transportSecurity === "implicit_tls",
		startTls: config.transportSecurity === "starttls",
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

	ctx.log.info(`Delivered email to ${message.to} via Worker Mailer (${config.transportSecurity})`);
}

export function createPlugin(options: WorkerMailerPluginOptions = {}): ResolvedPlugin {
	const transportSecurity = options.transportSecurity ?? DEFAULT_TRANSPORT_SECURITY;

	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: ["email:provide"],

		hooks: {
			"plugin:install": {
				handler: async (_event, ctx) => {
					await setDefault(ctx, "settings:host", toNonEmpty(options.host));
					await setDefault(ctx, "settings:transportSecurity", transportSecurity);
					await setDefault(
						ctx,
						"settings:port",
						options.port ?? defaultPortForTransportSecurity(transportSecurity),
					);
					await ctx.kv.delete("settings:transportSecurityMode");
					await ctx.kv.delete("settings:startTls");
					await ctx.kv.delete("settings:secure");
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
					description: "SMTP server hostname (for example: smtp.example.com)",
					default: options.host ?? "",
				},
				transportSecurity: {
					type: "select",
					label: "Transport Security",
					options: [
						{ value: "starttls", label: "STARTTLS" },
						{ value: "implicit_tls", label: "Implicit TLS / SMTPS" },
					],
					description: TLS_REQUIRED_MESSAGE,
					default: transportSecurity,
				},
				port: {
					type: "number",
					label: "SMTP Port",
					description: "Use 587 for STARTTLS or 465 for implicit TLS.",
					default: options.port ?? defaultPortForTransportSecurity(transportSecurity),
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
