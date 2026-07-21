/**
 * Built-in SMTP Email Transport
 *
 * Delivers EmDash emails through any standard SMTP server (Brevo relay,
 * Office365, Google Workspace, Fastmail, Amazon SES, self-hosted Postfix)
 * via raw TCP — the one network primitive sandboxed plugins cannot use.
 *
 * Registered as a built-in `email:deliver` provider when SMTP env vars are
 * present. On Cloudflare Workers it uses `cloudflare:sockets`; on Node it
 * uses `node:net` / `node:tls`. Configuration is env-only for the first
 * iteration — no admin UI yet.
 *
 * Env vars:
 *   EMAIL_SMTP_HOST     smtp-relay.brevo.com
 *   EMAIL_SMTP_PORT     587 (STARTTLS) or 465 (implicit TLS)
 *   EMAIL_SMTP_SECURE   "starttls" | "tls"  (default: inferred from port)
 *   EMAIL_SMTP_USER     you@example.com
 *   EMAIL_SMTP_PASS     xsmtpsib-…
 *   EMAIL_SMTP_FROM     Site <noreply@example.com>  (optional default sender)
 *
 * Cloudflare blocks outbound port 25 — this transport refuses port 25 with
 * a clear error. TLS is always required; plaintext auth is never attempted.
 */

import { decrypt, encrypt } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import type { EmailDeliverEvent, PluginContext } from "./types.js";

/** Plugin ID for the built-in SMTP email provider */
export const SMTP_EMAIL_PLUGIN_ID = "emdash-smtp";

/** Options key prefix for SMTP settings */
const SMTP_OPTION_PREFIX = "emdash:email:smtp:";
const SMTP_OPTION_PASSWORD = `${SMTP_OPTION_PREFIX}password`;

// ---------------------------------------------------------------------------
// Socket abstraction — cloudflare:sockets on Workers, node:net/tls on Node
// ---------------------------------------------------------------------------

interface SocketReader {
	read(): Promise<{ value?: Uint8Array; done: boolean }>;
}

export interface SmtpSocket {
	writer: { write(data: Uint8Array): Promise<void>; close(): Promise<void> };
	reader: SocketReader;
	startTls?(): Promise<SmtpSocket>;
	close(): Promise<void>;
}

type ConnectFn = (host: string, port: number, secure: "starttls" | "tls") => Promise<SmtpSocket>;

function encodeUtf8(input: string): Uint8Array {
	return new TextEncoder().encode(input);
}

function decodeUtf8(input: Uint8Array): string {
	return new TextDecoder().decode(input);
}

/** Concatenate chunks into one buffer. */
function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

/** Read until CRLF or buffer exceeds limit. Returns decoded line without CRLF. */
async function readLine(reader: SocketReader, buffered: Uint8Array[]): Promise<string> {
	const LIMIT = 8192;
	while (true) {
		const joined = concat(buffered);
		const text = decodeUtf8(joined);
		const idx = text.indexOf("\r\n");
		if (idx >= 0) {
			const line = text.slice(0, idx);
			const rest = joined.slice(idx + 2);
			buffered.length = 0;
			if (rest.length > 0) buffered.push(rest);
			return line;
		}
		if (joined.length > LIMIT) {
			throw new Error("SMTP line too long");
		}
		const { value, done } = await reader.read();
		if (done) throw new Error("SMTP connection closed unexpectedly");
		if (value) buffered.push(value);
	}
}

/** Read a full SMTP reply (possibly multi-line: "250-...", "250 ..."). */
async function readReply(
	reader: SocketReader,
	buffered: Uint8Array[],
): Promise<{ code: number; lines: string[] }> {
	const lines: string[] = [];
	while (true) {
		const line = await readLine(reader, buffered);
		lines.push(line);
		// "250 OK" (space) = final line; "250-..." (hyphen) = more to come
		if (line.length < 4 || line[3] !== "-") break;
	}
	const code = Number.parseInt(lines[0]?.slice(0, 3) ?? "0", 10);
	return { code, lines };
}

/** Assert reply code matches expectation; throw with server message otherwise. */
function expectCode(
	reply: { code: number; lines: string[] },
	expected: number | number[],
	context: string,
): void {
	const codes = Array.isArray(expected) ? expected : [expected];
	if (!codes.includes(reply.code)) {
		throw new Error(
			`SMTP ${context} failed: expected ${codes.join("/")}, got ${reply.code} — ${reply.lines.join(" | ")}`,
		);
	}
}

/** Base64 encode ASCII string (SMTP AUTH). */
function b64(input: string): string {
	// Workers + Node both have btoa
	return btoa(input);
}

const CRLF_REGEX = /[\r\n]/g;

/** Sanitize a header value against CRLF injection. */
function sanitizeHeader(value: string): string {
	return value.replace(CRLF_REGEX, " ");
}

const ADDRESS_REGEX = /^\s*(?:"([^"]*)"|([^<]*))?\s*<([^>]+)>\s*$/;

/** Parse "Name <email@example.com>" or bare "email@example.com". */
function parseAddress(input: string): { email: string; name?: string } {
	const match = input.match(ADDRESS_REGEX);
	if (match) {
		const name = (match[1] ?? match[2] ?? "").trim();
		return { email: match[3].trim(), ...(name ? { name } : {}) };
	}
	return { email: input.trim() };
}

/** Build a dot-stuffed MIME body. */
function buildMime(params: {
	from: { email: string; name?: string };
	to: string;
	subject: string;
	text: string;
	html?: string;
}): string {
	const { from, to, subject, text, html } = params;
	const headers: string[] = [
		`From: ${from.name ? `"${sanitizeHeader(from.name)}" <${from.email}>` : from.email}`,
		`To: ${to}`,
		`Subject: ${sanitizeHeader(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@emdash>`,
		`MIME-Version: 1.0`,
	];

	let body: string;
	if (html) {
		const boundary = `----=_emdash_${crypto.randomUUID()}`;
		headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		body = [
			`--${boundary}`,
			`Content-Type: text/plain; charset=utf-8`,
			`Content-Transfer-Encoding: 7bit`,
			``,
			text,
			`--${boundary}`,
			`Content-Type: text/html; charset=utf-8`,
			`Content-Transfer-Encoding: 7bit`,
			``,
			html,
			`--${boundary}--`,
		].join("\r\n");
	} else {
		headers.push(`Content-Type: text/plain; charset=utf-8`);
		headers.push(`Content-Transfer-Encoding: 7bit`);
		body = text;
	}

	const message = `${headers.join("\r\n")}\r\n\r\n${body}`;
	// Dot-stuffing: lines starting with "." get an extra "."
	return message.replace(/^\./gm, "..");
}

// ---------------------------------------------------------------------------
// Runtime-specific connect implementations
// ---------------------------------------------------------------------------

async function connectCloudflare(
	host: string,
	port: number,
	secure: "starttls" | "tls",
): Promise<SmtpSocket> {
	// @ts-expect-error — virtual module only available on Cloudflare Workers
	const { connect } = await import("cloudflare:sockets");

	if (secure === "tls") {
		const sock = connect(`${host}:${port}`, { secureTransport: "on", allowHalfOpen: false });
		const reader = sock.readable.getReader();
		return {
			writer: {
				write: async (data) => sock.writable.getWriter().write(data),
				close: async () => sock.writable.getWriter().close(),
			},
			reader,
			close: () => sock.close(),
		};
	}

	// STARTTLS: connect plaintext, upgrade after EHLO
	const sock = connect(`${host}:${port}`, { secureTransport: "off", allowHalfOpen: false });
	const reader = sock.readable.getReader();

	return {
		writer: {
			write: async (data) => sock.writable.getWriter().write(data),
			close: async () => sock.writable.getWriter().close(),
		},
		reader,
		startTls: async () => {
			const tlsSock = sock.startTls();
			const tlsReader = tlsSock.readable.getReader();
			return {
				writer: {
					write: async (data) => tlsSock.writable.getWriter().write(data),
					close: async () => tlsSock.writable.getWriter().close(),
				},
				reader: tlsReader,
				close: () => tlsSock.close(),
			};
		},
		close: () => sock.close(),
	};
}

async function connectNode(
	host: string,
	port: number,
	secure: "starttls" | "tls",
): Promise<SmtpSocket> {
	if (secure === "tls") {
		const { connect: tlsConnect } = await import("node:tls");
		return new Promise((resolve, reject) => {
			const sock = tlsConnect({ host, port, servername: host }, () => {
				const chunks: Uint8Array[] = [];
				let resolveRead: ((r: { value?: Uint8Array; done: boolean }) => void) | null = null;
				sock.on("data", (chunk: Buffer) => {
					const u8 = new Uint8Array(chunk);
					if (resolveRead) {
						resolveRead({ value: u8, done: false });
						resolveRead = null;
					} else {
						chunks.push(u8);
					}
				});
				sock.on("end", () => resolveRead?.({ done: true }));
				sock.on("error", reject);
				// eslint-disable-next-line promise/no-multiple-resolved -- resolve happens once in connect callback
				resolve({
					writer: {
						write: (data) =>
							new Promise((res, rej) =>
								sock.write(data, (e: Error | null | undefined) => (e ? rej(e) : res())),
							),
						close: () => new Promise((res) => sock.end(res)),
					},
					reader: {
						read: () =>
							new Promise((res) => {
								if (chunks.length > 0) return res({ value: chunks.shift()!, done: false });
								resolveRead = res;
							}),
					},
					close: () => new Promise((res) => sock.end(res)),
				});
			});
			sock.on("error", reject);
		});
	}

	// STARTTLS on Node: plain socket, upgrade after EHLO
	const { connect: netConnect } = await import("node:net");
	const { connect: tlsConnect, TLSSocket } = await import("node:tls");

	return new Promise((resolve, reject) => {
		const sock = netConnect({ host, port }, () => {
			const chunks: Uint8Array[] = [];
			let resolveRead: ((r: { value?: Uint8Array; done: boolean }) => void) | null = null;
			sock.on("data", (chunk: Buffer) => {
				const u8 = new Uint8Array(chunk);
				if (resolveRead) {
					resolveRead({ value: u8, done: false });
					resolveRead = null;
				} else {
					chunks.push(u8);
				}
			});
			sock.on("end", () => resolveRead?.({ done: true }));
			sock.on("error", reject);

			// eslint-disable-next-line promise/no-multiple-resolved -- resolve happens once in connect callback
			const makeSocket = (s: InstanceType<typeof TLSSocket> | typeof sock): SmtpSocket => ({
				writer: {
					write: (data) =>
						new Promise((res, rej) =>
							s.write(data, (e: Error | null | undefined) => (e ? rej(e) : res())),
						),
					close: () => new Promise((res) => s.end(res)),
				},
				reader: {
					read: () =>
						new Promise((res) => {
							if (chunks.length > 0) return res({ value: chunks.shift()!, done: false });
							resolveRead = res;
						}),
				},
				close: () => new Promise((res) => s.end(res)),
			});

			resolve({
				...makeSocket(sock),
				startTls: () =>
					new Promise((res, rej) => {
						const tlsSock = tlsConnect({ socket: sock, servername: host }, () => {
							chunks.length = 0;
							tlsSock.on("data", (chunk: Buffer) => {
								const u8 = new Uint8Array(chunk);
								if (resolveRead) {
									resolveRead({ value: u8, done: false });
									resolveRead = null;
								} else {
									chunks.push(u8);
								}
							});
							tlsSock.on("end", () => resolveRead?.({ done: true }));
							tlsSock.on("error", rej);
							res(makeSocket(tlsSock));
						});
						tlsSock.on("error", rej);
					}),
			});
		});
		sock.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// SMTP session
// ---------------------------------------------------------------------------

export interface SmtpConfig {
	host: string;
	port: number;
	secure: "starttls" | "tls";
	user: string;
	pass: string;
	from?: string;
	/** Connect + overall timeout in ms (default 30s) */
	timeoutMs?: number;
}

/** Load SMTP config from env; returns null if not configured. */
export function loadSmtpConfigFromEnv(): SmtpConfig | null {
	const host = process.env.EMAIL_SMTP_HOST;
	if (!host) return null;
	const port = Number.parseInt(process.env.EMAIL_SMTP_PORT ?? "587", 10);
	if (port === 25) {
		throw new Error(
			"EMAIL_SMTP_PORT=25 is not supported: Cloudflare blocks outbound port 25. " +
				"Use 587 (STARTTLS) or 465 (implicit TLS) instead.",
		);
	}
	const secure = (process.env.EMAIL_SMTP_SECURE ?? (port === 465 ? "tls" : "starttls")) as
		| "starttls"
		| "tls";
	if (secure !== "starttls" && secure !== "tls") {
		throw new Error(`EMAIL_SMTP_SECURE must be "starttls" or "tls", got "${secure}"`);
	}
	const user = process.env.EMAIL_SMTP_USER;
	const pass = process.env.EMAIL_SMTP_PASS;
	if (!user || !pass) {
		throw new Error("EMAIL_SMTP_USER and EMAIL_SMTP_PASS are required when EMAIL_SMTP_HOST is set");
	}
	return {
		host,
		port,
		secure,
		user,
		pass,
		...(process.env.EMAIL_SMTP_FROM ? { from: process.env.EMAIL_SMTP_FROM } : {}),
	};
}

/** Load SMTP config from DB, decrypting the password with the encryption key. */
export async function loadSmtpConfigFromDb(
	db: Kysely<Database>,
	encryptionKey: string,
): Promise<SmtpConfig | null> {
	const repo = new OptionsRepository(db);
	const host = await repo.get<string>(`${SMTP_OPTION_PREFIX}host`);
	if (!host) return null;

	const port = await repo.get<number>(`${SMTP_OPTION_PREFIX}port`);
	const secure = await repo.get<"starttls" | "tls">(`${SMTP_OPTION_PREFIX}secure`);
	const user = await repo.get<string>(`${SMTP_OPTION_PREFIX}user`);
	const encryptedPass = await repo.get<string>(SMTP_OPTION_PASSWORD);
	const from = await repo.get<string>(`${SMTP_OPTION_PREFIX}from`);

	if (!port || !secure || !user || !encryptedPass) {
		return null;
	}

	const pass = await decrypt(encryptedPass, encryptionKey);
	return {
		host,
		port,
		secure,
		user,
		pass,
		...(from ? { from } : {}),
	};
}

/** Save SMTP config to DB, encrypting the password with the encryption key. */
export async function saveSmtpConfigToDb(
	db: Kysely<Database>,
	encryptionKey: string,
	config: SmtpConfig,
): Promise<void> {
	const repo = new OptionsRepository(db);
	await repo.set(`${SMTP_OPTION_PREFIX}host`, config.host);
	await repo.set(`${SMTP_OPTION_PREFIX}port`, config.port);
	await repo.set(`${SMTP_OPTION_PREFIX}secure`, config.secure);
	await repo.set(`${SMTP_OPTION_PREFIX}user`, config.user);
	await repo.set(SMTP_OPTION_PASSWORD, await encrypt(config.pass, encryptionKey));
	if (config.from) {
		await repo.set(`${SMTP_OPTION_PREFIX}from`, config.from);
	} else {
		await repo.delete(`${SMTP_OPTION_PREFIX}from`);
	}
}

/** Clear all SMTP config from DB. */
export async function clearSmtpConfigFromDb(db: Kysely<Database>): Promise<void> {
	const repo = new OptionsRepository(db);
	await repo.delete(`${SMTP_OPTION_PREFIX}host`);
	await repo.delete(`${SMTP_OPTION_PREFIX}port`);
	await repo.delete(`${SMTP_OPTION_PREFIX}secure`);
	await repo.delete(`${SMTP_OPTION_PREFIX}user`);
	await repo.delete(SMTP_OPTION_PASSWORD);
	await repo.delete(`${SMTP_OPTION_PREFIX}from`);
}

/**
 * Load SMTP config from DB first, then fall back to env vars.
 * Returns null if neither is configured.
 *
 * The encryption key is the same `EMDASH_ENCRYPTION_KEY` used for plugin
 * secrets — the SMTP password is a plugin secret in spirit.
 */
export async function loadSmtpConfig(
	db: Kysely<Database>,
	encryptionKey: string,
): Promise<SmtpConfig | null> {
	const dbConfig = await loadSmtpConfigFromDb(db, encryptionKey);
	if (dbConfig) return dbConfig;
	return loadSmtpConfigFromEnv();
}

/** Deliver one message over SMTP. Throws on any protocol or network error. */
export async function deliverSmtp(
	config: SmtpConfig,
	message: EmailDeliverEvent["message"],
	ctx: PluginContext,
	connectFn?: ConnectFn,
): Promise<void> {
	const from = config.from ? parseAddress(config.from) : { email: config.user };
	const timeoutMs = config.timeoutMs ?? 30_000;

	const connect: ConnectFn =
		connectFn ??
		(async (host, port, secure) => {
			// Prefer Cloudflare sockets when available (Workers runtime)
			try {
				return await connectCloudflare(host, port, secure);
			} catch (cfError) {
				// Fall back to Node sockets (astro dev, Node deployments)
				try {
					return await connectNode(host, port, secure);
				} catch (nodeError) {
					throw new Error(
						`Failed to connect to SMTP server ${host}:${port} — ` +
							`Cloudflare sockets: ${cfError instanceof Error ? cfError.message : String(cfError)}; ` +
							`Node sockets: ${nodeError instanceof Error ? nodeError.message : String(nodeError)}`,
						{ cause: nodeError },
					);
				}
			}
		});

	let socket: SmtpSocket | null = null;
	const timer = setTimeout(() => {
		socket?.close().catch(() => {});
		throw new Error(`SMTP operation timed out after ${timeoutMs}ms`);
	}, timeoutMs);

	try {
		socket = await connect(config.host, config.port, config.secure);
		const buffered: Uint8Array[] = [];

		// Greeting
		expectCode(await readReply(socket.reader, buffered), 220, "greeting");

		const send = async (line: string) => {
			await socket!.writer.write(encodeUtf8(`${line}\r\n`));
		};

		// EHLO
		await send(`EHLO emdash`);
		expectCode(await readReply(socket.reader, buffered), 250, "EHLO");

		// STARTTLS upgrade
		if (config.secure === "starttls") {
			if (!socket.startTls)
				throw new Error("STARTTLS requested but socket does not support upgrade");
			await send("STARTTLS");
			expectCode(await readReply(socket.reader, buffered), 220, "STARTTLS");
			socket = await socket.startTls();
			buffered.length = 0;
			// Re-EHLO after TLS upgrade
			await send(`EHLO emdash`);
			expectCode(await readReply(socket.reader, buffered), 250, "EHLO after STARTTLS");
		}

		// AUTH LOGIN
		await send("AUTH LOGIN");
		expectCode(await readReply(socket.reader, buffered), 334, "AUTH LOGIN");
		await send(b64(config.user));
		expectCode(await readReply(socket.reader, buffered), 334, "AUTH username");
		await send(b64(config.pass));
		expectCode(await readReply(socket.reader, buffered), 235, "AUTH password");

		// Envelope
		await send(`MAIL FROM:<${from.email}>`);
		expectCode(await readReply(socket.reader, buffered), 250, "MAIL FROM");
		await send(`RCPT TO:<${message.to}>`);
		expectCode(await readReply(socket.reader, buffered), [250, 251], "RCPT TO");

		// Data
		await send("DATA");
		expectCode(await readReply(socket.reader, buffered), 354, "DATA");
		const mime = buildMime({
			from,
			to: message.to,
			subject: message.subject,
			text: message.text,
			...(message.html ? { html: message.html } : {}),
		});
		await socket.writer.write(encodeUtf8(`${mime}\r\n.\r\n`));
		expectCode(await readReply(socket.reader, buffered), 250, "message accepted");

		// Quit
		await send("QUIT");

		ctx.log.info("email delivered via SMTP", {
			to: message.to,
			subject: message.subject,
			host: config.host,
			port: config.port,
		});
	} finally {
		clearTimeout(timer);
		await socket?.close().catch(() => {});
	}
}

/**
 * Build the email:deliver handler.
 *
 * Exported for testing — production code should use {@link createSmtpPlugin}.
 */
export function createSmtpEmailDeliver(
	config: SmtpConfig,
	connectFn?: ConnectFn,
): (event: EmailDeliverEvent, ctx: PluginContext) => Promise<void> {
	return async (event, ctx) => deliverSmtp(config, event.message, ctx, connectFn);
}
