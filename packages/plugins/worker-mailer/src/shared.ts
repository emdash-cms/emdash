import type { AuthType, EmailOptions, WorkerMailerOptions } from "@workermailer/smtp";
import type { PluginContext } from "emdash";
import type { PluginHooks } from "emdash";

export const PLUGIN_ID = "worker-mailer";
export const VERSION = "0.1.0";
export const DEFAULT_AUTH_TYPE = "plain";
export const DEFAULT_SECURE_PORT = 465;
export const SECURE_CONNECTION_MESSAGE =
	"Cloudflare Workers SMTP connections must start secure. Configure an implicit TLS / SMTPS endpoint, usually on port 465.";

export interface WorkerMailerConfig {
	host: string;
	port: number;
	authType: AuthType;
	username: string;
	password: string;
	fromEmail: string;
	fromName: string | undefined;
}

function isAuthType(value: string): value is AuthType {
	return value === "plain" || value === "login" || value === "cram-md5";
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

export async function readConfig(ctx: PluginContext): Promise<WorkerMailerConfig> {
	const host = toNonEmpty(await ctx.kv.get<string>("settings:host"));
	const port = coerceNumber(await ctx.kv.get<number>("settings:port"), DEFAULT_SECURE_PORT);
	const authType = coerceAuthType(await ctx.kv.get<string>("settings:authType"), DEFAULT_AUTH_TYPE);
	const username = toNonEmpty(await ctx.kv.get<string>("settings:username"));
	const password = toNonEmpty(await ctx.kv.get<string>("settings:password"));

	const explicitFrom = toNonEmpty(await ctx.kv.get<string>("settings:fromEmail"));
	const fromEmail = explicitFrom ?? username;
	const fromName = toNonEmpty(await ctx.kv.get<string>("settings:fromName"));

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

export async function installDefaults(ctx: PluginContext): Promise<void> {
	await setDefault(ctx, "settings:port", DEFAULT_SECURE_PORT);
	await ctx.kv.delete("settings:transportSecurity");
	await ctx.kv.delete("settings:transportSecurityMode");
	await ctx.kv.delete("settings:startTls");
	await ctx.kv.delete("settings:secure");
	await setDefault(ctx, "settings:authType", DEFAULT_AUTH_TYPE);
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
		secure: true,
		startTls: false,
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

	ctx.log.info(`Delivered email to ${message.to} via Worker Mailer (implicit TLS)`);
}

export function createWorkerMailerHooks(): Pick<PluginHooks, "plugin:install" | "email:deliver"> {
	return {
		"plugin:install": {
			handler: async (_event, ctx) => {
				await installDefaults(ctx);
			},
		},
		"email:deliver": {
			exclusive: true,
			handler: async (event, ctx) => {
				const config = await readConfig(ctx);
				await sendWithWorkerMailer(ctx, config, event.message);
			},
		},
	};
}
