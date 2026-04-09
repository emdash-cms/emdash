import type { AuthType, EmailOptions, WorkerMailerOptions } from "@workermailer/smtp";
import type { PluginContext } from "emdash";

export const PLUGIN_ID = "worker-mailer";
export const VERSION = "0.1.0";
export const DEFAULT_TRANSPORT_SECURITY = "starttls";
export const DEFAULT_AUTH_TYPE = "plain";
export const IMPLICIT_TLS_PORT = 465;
export const STARTTLS_PORT = 587;
export const TLS_REQUIRED_MESSAGE =
	"Choose STARTTLS on port 587 or implicit TLS on port 465. Plaintext SMTP is not supported.";

export type TransportSecurity = "starttls" | "implicit_tls";

export interface WorkerMailerPluginOptions extends Record<string, unknown> {
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

export interface WorkerMailerConfig {
	host: string;
	port: number;
	transportSecurity: TransportSecurity;
	authType: AuthType;
	username: string;
	password: string;
	fromEmail: string;
	fromName: string | undefined;
}

function isAuthType(value: string): value is AuthType {
	return value === "plain" || value === "login" || value === "cram-md5";
}

function isTransportSecurity(value: string): value is TransportSecurity {
	return value === "starttls" || value === "implicit_tls";
}

export function defaultPortForTransportSecurity(transportSecurity: TransportSecurity): number {
	return transportSecurity === "implicit_tls" ? IMPLICIT_TLS_PORT : STARTTLS_PORT;
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

export async function readConfig(
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

export async function installDefaults(
	ctx: PluginContext,
	options: WorkerMailerPluginOptions,
): Promise<void> {
	const transportSecurity = options.transportSecurity ?? DEFAULT_TRANSPORT_SECURITY;

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

export async function sendWithWorkerMailer(
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
