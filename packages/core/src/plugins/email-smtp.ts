/**
 * Built-in SMTP Email Transport
 *
 * Delivers EmDash emails through any standard SMTP server (Brevo relay,
 * Office365, Google Workspace, Fastmail, Amazon SES, self-hosted Postfix)
 * via raw TCP — the one network primitive sandboxed plugins cannot use.
 *
 * Registered as a built-in `email:deliver` provider. On Cloudflare Workers it
 * uses `cloudflare:sockets`; on Node it uses `node:net` / `node:tls`.
 * Configuration comes from env vars (see below) or the Settings → Email
 * admin UI (stored encrypted in the database).
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

import { promisify } from "node:util";

import { decrypt, encrypt } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import { ENCRYPTION_KEY_PREFIX, parseEncryptionKeys } from "../config/secrets.js";
import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import type { EmailDeliverEvent, PluginContext } from "./types.js";

/** Plugin ID for the built-in SMTP email provider */
export const SMTP_EMAIL_PLUGIN_ID = "emdash-smtp";

/** Options key prefix for SMTP settings */
const SMTP_OPTION_PREFIX = "emdash:email:smtp:";
const SMTP_OPTION_PASSWORD = `${SMTP_OPTION_PREFIX}password`;

/**
 * `EMDASH_ENCRYPTION_KEY` may hold a comma-separated key list (rotation);
 * `encrypt()`/`decrypt()` from `@emdash-cms/auth` expect one raw base64url
 * key material string. The first key encrypts; all keys are tried for
 * decryption.
 */
async function toKeyMaterials(encryptionKey: string): Promise<string[]> {
	const parsed = await parseEncryptionKeys(encryptionKey);
	if (!parsed || parsed.length === 0) {
		throw new Error("EMDASH_ENCRYPTION_KEY is empty");
	}
	return parsed.map((k) => k.raw.slice(ENCRYPTION_KEY_PREFIX.length));
}

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

/** Byte index of the first CRLF; the buffer is bytes, so a UTF-16 string
 * index would drift on multi-byte characters in server replies. */
function indexOfCrlf(buf: Uint8Array): number {
	for (let i = 0; i + 1 < buf.length; i++) {
		if (buf[i] === 13 && buf[i + 1] === 10) return i;
	}
	return -1;
}

/** Read until CRLF or buffer exceeds limit. Returns decoded line without CRLF. */
async function readLine(reader: SocketReader, buffered: Uint8Array[]): Promise<string> {
	const LIMIT = 8192;
	while (true) {
		const joined = concat(buffered);
		const idx = indexOfCrlf(joined);
		if (idx >= 0) {
			const line = decodeUtf8(joined.slice(0, idx));
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

/**
 * Map raw SMTP failures to actionable messages.
 * The raw server line stays in the message so support can still see it.
 */
function humanizeSmtpError(code: number, context: string, serverLine: string): string {
	const raw = `${code} ${serverLine}`.trim();
	// 535 = auth rejected at AUTH; 530 = auth required / relay denied at MAIL FROM
	if (code === 535) {
		return (
			`Authentication failed (${raw}). Username or password rejected by the server. ` +
			`For Brevo, use your login email as username and an SMTP key (xsmtpsib-…), not your account password.`
		);
	}
	if (code === 530 || code === 550) {
		return (
			`Relay denied (${raw}). The server rejected the sender or recipient. ` +
			`Check that the "From" address belongs to a domain verified with your provider.`
		);
	}
	if (code === 534) {
		return (
			`Authentication mechanism rejected (${raw}). The server wants a different auth method ` +
			`(often OAuth2 for Gmail/Outlook). This provider may not support plain SMTP auth.`
		);
	}
	return `SMTP ${context} failed: ${raw}`;
}

/** Assert reply code matches expectation; throw with server message otherwise. */
function expectCode(
	reply: { code: number; lines: string[] },
	expected: number | number[],
	context: string,
): void {
	const codes = Array.isArray(expected) ? expected : [expected];
	if (!codes.includes(reply.code)) {
		const serverLine = reply.lines.join(" | ");
		throw new Error(humanizeSmtpError(reply.code, context, serverLine));
	}
}

/**
 * Transcript recorder. Each SMTP step logs what was sent and received so a
 * hang or rejection is debuggable from the worker logs instead of requiring
 * a local repro. AUTH credential lines are redacted before recording.
 */
class SmtpTrace {
	private readonly events: string[] = [];
	private readonly start = Date.now();

	record(direction: "send" | "recv", line: string, sensitive = false): void {
		const elapsed = Date.now() - this.start;
		const safe = sensitive ? "[credentials]" : line.replace(/[\r\n]/g, " ").slice(0, 120);
		this.events.push(`[+${elapsed}ms] ${direction === "send" ? "C>" : "S<"} ${safe}`);
	}

	/** Last few events — enough context to see where the conversation stalled. */
	tail(n = 6): string {
		return this.events.slice(-n).join(" | ");
	}
}

/**
 * SMTP delivery failure with a message that is safe to show to an admin:
 * a humanized protocol/config error without transcripts or credentials.
 */
export class SmtpDeliveryError extends Error {
	override name = "SmtpDeliveryError";
}

/** Base64 encode a UTF-8 string (bare `btoa` throws on non-Latin-1 input). */
function b64(input: string): string {
	// Workers + Node both have btoa
	return btoa(unescape(encodeURIComponent(input)));
}

/** Base64 encode UTF-8 text and wrap at 76 columns (RFC 2045 body limit). */
function b64Body(input: string): string {
	return b64(input)
		.replace(/.{1,76}/g, "$&\r\n")
		.trimEnd();
}

const CRLF_REGEX = /[\r\n]/g;

/** Sanitize a header value against CRLF injection. */
function sanitizeHeader(value: string): string {
	return value.replace(CRLF_REGEX, " ");
}

const NON_ASCII_REGEX = /[^\x20-\x7E]/;

/** RFC 2047 encoded-word for UTF-8 headers (Subject, From, Reply-To). */
function encodeHeader(value: string): string {
	const sanitized = sanitizeHeader(value);
	// Only encode when non-ASCII is present — ASCII headers stay readable.
	if (!NON_ASCII_REGEX.test(sanitized)) return sanitized;
	return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(sanitized)))}?=`;
}

const ENVELOPE_ADDRESS_REGEX = /^[^\s<>,;"\\]+@[^\s<>,;"\\]+$/;

/**
 * Validate an address before interpolating it into a MAIL FROM / RCPT TO
 * wire command. Rejects control characters, whitespace and angle brackets
 * so a crafted address cannot inject SMTP commands.
 */
function assertEnvelopeAddress(address: string, label: string): void {
	if (!ENVELOPE_ADDRESS_REGEX.test(address)) {
		throw new SmtpDeliveryError(`Invalid ${label} address for SMTP delivery`);
	}
}

/**
 * Format "Name <email>" for From/Reply-To. An RFC 2047 encoded-word must
 * not sit inside a quoted string, so non-ASCII names are emitted unquoted
 * as encoded-words; ASCII names are quoted with `"` and `\` escaped.
 */
function formatNameAddress(name: string, email: string): string {
	const sanitized = sanitizeHeader(name);
	if (NON_ASCII_REGEX.test(sanitized)) {
		return `${encodeHeader(sanitized)} <${email}>`;
	}
	return `"${sanitized.replace(/[\\"]/g, "\\$&")}" <${email}>`;
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

/**
 * Build the MIME message. Bodies are base64-encoded and wrapped at 76
 * columns, so no line ever starts with a dot (no dot-stuffing needed)
 * and no line exceeds the SMTP 998-octet limit.
 */
function buildMime(params: {
	from: { email: string; name?: string };
	replyTo?: string;
	to: string;
	subject: string;
	text: string;
	html?: string;
}): string {
	const { from, replyTo, to, subject, text, html } = params;
	const headers: string[] = [
		`From: ${from.name ? formatNameAddress(from.name, from.email) : from.email}`,
		`To: ${sanitizeHeader(to)}`,
		`Subject: ${encodeHeader(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@${from.email.split("@")[1] || "emdash.invalid"}>`,
		`MIME-Version: 1.0`,
	];
	if (replyTo) {
		headers.push(`Reply-To: ${encodeHeader(replyTo)}`);
	}

	let body: string;
	if (html) {
		const boundary = `----=_emdash_${crypto.randomUUID()}`;
		headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		body = [
			`--${boundary}`,
			`Content-Type: text/plain; charset=utf-8`,
			`Content-Transfer-Encoding: base64`,
			``,
			b64Body(text),
			`--${boundary}`,
			`Content-Type: text/html; charset=utf-8`,
			`Content-Transfer-Encoding: base64`,
			``,
			b64Body(html),
			`--${boundary}--`,
		].join("\r\n");
	} else {
		headers.push(`Content-Type: text/plain; charset=utf-8`);
		headers.push(`Content-Transfer-Encoding: base64`);
		body = b64Body(text);
	}

	return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

// ---------------------------------------------------------------------------
// Runtime-specific connect implementations
// ---------------------------------------------------------------------------

// Cloudflare sockets need `await sock.opened` before the stream is usable —
// unlike Node, where the connect callback signals readiness. Skipping this
// makes writes hang silently after STARTTLS.
async function wrapCloudflareSocket(sock: {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close(): Promise<void>;
	opened: Promise<unknown>;
}): Promise<SmtpSocket> {
	await sock.opened;
	let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	return {
		writer: {
			write: async (data) => {
				if (!writer) writer = sock.writable.getWriter();
				await writer.write(data);
			},
			close: async () => {
				await writer?.close();
				writer = null;
			},
		},
		reader: sock.readable.getReader(),
		close: () => sock.close(),
	};
}

async function connectCloudflare(
	host: string,
	port: number,
	secure: "starttls" | "tls",
): Promise<SmtpSocket> {
	// @ts-expect-error — virtual module only available on Cloudflare Workers
	const { connect } = await import("cloudflare:sockets");

	if (secure === "tls") {
		const sock = connect(`${host}:${port}`, { secureTransport: "on", allowHalfOpen: false });
		return wrapCloudflareSocket(sock);
	}

	// STARTTLS: connect plaintext, upgrade after EHLO. Cloudflare requires
	// `secureTransport: "starttls"` (not "off") to later allow `sock.startTls()`.
	const sock = connect(`${host}:${port}`, { secureTransport: "starttls", allowHalfOpen: false });
	const wrapped = await wrapCloudflareSocket(sock);

	return {
		...wrapped,
		startTls: async () => {
			// Cloudflare: the plaintext socket's writer holds the stream lock.
			// Release it BEFORE startTls() — otherwise the upgraded socket's
			// writable is still locked and the first write throws.
			await wrapped.writer.close().catch(() => {});
			return wrapCloudflareSocket(sock.startTls());
		},
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
				const sockWrite = promisify(sock.write.bind(sock));
				const sockEnd = promisify(sock.end.bind(sock));
				resolve({
					writer: {
						write: (data: Uint8Array) => sockWrite(data),
						close: () => sockEnd(),
					},
					reader: {
						read: () =>
							new Promise((res) => {
								if (chunks.length > 0) return res({ value: chunks.shift()!, done: false });
								resolveRead = res;
							}),
					},
					close: () => sockEnd(),
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

			const makeSocket = (s: InstanceType<typeof TLSSocket> | typeof sock): SmtpSocket => {
				const sWrite = promisify(s.write.bind(s));
				const sEnd = promisify(s.end.bind(s));
				return {
					writer: {
						write: (data: Uint8Array) => sWrite(data),
						close: () => sEnd(),
					},
					reader: {
						read: () =>
							new Promise((res) => {
								if (chunks.length > 0) return res({ value: chunks.shift()!, done: false });
								resolveRead = res;
							}),
					},
					close: () => sEnd(),
				};
			};

			resolve({
				...makeSocket(sock),
				startTls: () =>
					new Promise((res, rej) => {
						// Detach the plaintext listeners first — they share the
						// read-buffer state with the TLS listeners below and would
						// otherwise deliver raw TLS record bytes into it.
						sock.removeAllListeners("data");
						sock.removeAllListeners("end");
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
	fromName?: string;
	fromEmail?: string;
	replyTo?: string;
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
	const secureRaw = process.env.EMAIL_SMTP_SECURE ?? (port === 465 ? "tls" : "starttls");
	if (secureRaw !== "starttls" && secureRaw !== "tls") {
		throw new Error(`EMAIL_SMTP_SECURE must be "starttls" or "tls", got "${secureRaw}"`);
	}
	const secure: "starttls" | "tls" = secureRaw;
	const user = process.env.EMAIL_SMTP_USER;
	const pass = process.env.EMAIL_SMTP_PASS;
	if (!user || !pass) {
		throw new Error("EMAIL_SMTP_USER and EMAIL_SMTP_PASS are required when EMAIL_SMTP_HOST is set");
	}
	// Support both structured fields and legacy EMAIL_SMTP_FROM
	let fromName: string | undefined;
	let fromEmail: string | undefined;
	if (process.env.EMAIL_SMTP_FROM_NAME && process.env.EMAIL_SMTP_FROM_EMAIL) {
		fromName = process.env.EMAIL_SMTP_FROM_NAME;
		fromEmail = process.env.EMAIL_SMTP_FROM_EMAIL;
	} else if (process.env.EMAIL_SMTP_FROM) {
		const parsed = parseAddress(process.env.EMAIL_SMTP_FROM);
		fromName = parsed.name;
		fromEmail = parsed.email;
	}
	return {
		host,
		port,
		secure,
		user,
		pass,
		...(fromName ? { fromName } : {}),
		...(fromEmail ? { fromEmail } : {}),
		...(process.env.EMAIL_SMTP_REPLY_TO ? { replyTo: process.env.EMAIL_SMTP_REPLY_TO } : {}),
	};
}

/** Load SMTP config from DB, decrypting the password with the encryption key. */
export async function loadSmtpConfigFromDb(
	db: Kysely<Database>,
	encryptionKey: string,
): Promise<SmtpConfig | null> {
	const repo = new OptionsRepository(db);
	// One round trip for all fields — this runs on every send.
	const values = await repo.getMany<string | number>([
		`${SMTP_OPTION_PREFIX}host`,
		`${SMTP_OPTION_PREFIX}port`,
		`${SMTP_OPTION_PREFIX}secure`,
		`${SMTP_OPTION_PREFIX}user`,
		SMTP_OPTION_PASSWORD,
		`${SMTP_OPTION_PREFIX}fromName`,
		`${SMTP_OPTION_PREFIX}fromEmail`,
		`${SMTP_OPTION_PREFIX}replyTo`,
	]);
	const str = (key: string) => {
		const value = values.get(key);
		return typeof value === "string" && value ? value : undefined;
	};
	const host = str(`${SMTP_OPTION_PREFIX}host`);
	const port = Number(values.get(`${SMTP_OPTION_PREFIX}port`)) || undefined;
	const secureRaw = str(`${SMTP_OPTION_PREFIX}secure`);
	const secure = secureRaw === "tls" || secureRaw === "starttls" ? secureRaw : undefined;
	const user = str(`${SMTP_OPTION_PREFIX}user`);
	const encryptedPass = str(SMTP_OPTION_PASSWORD);
	const fromName = str(`${SMTP_OPTION_PREFIX}fromName`);
	const fromEmail = str(`${SMTP_OPTION_PREFIX}fromEmail`);
	const replyTo = str(`${SMTP_OPTION_PREFIX}replyTo`);

	if (!host || !port || !secure || !user || !encryptedPass) {
		return null;
	}

	// Try every configured key (rotation) — the password may have been
	// encrypted with a key that is no longer primary.
	let pass: string | null = null;
	for (const keyMaterial of await toKeyMaterials(encryptionKey)) {
		try {
			pass = await decrypt(encryptedPass, keyMaterial);
			break;
		} catch {
			// Not this key — try the next one.
		}
	}
	if (pass === null) {
		console.warn(
			"[email-smtp] Stored SMTP password cannot be decrypted with the configured " +
				"encryption key(s) — re-save the password in Settings → Email.",
		);
		return null;
	}
	return {
		host,
		port,
		secure,
		user,
		pass,
		...(fromName ? { fromName } : {}),
		...(fromEmail ? { fromEmail } : {}),
		...(replyTo ? { replyTo } : {}),
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
	const [primaryKey] = await toKeyMaterials(encryptionKey);
	if (primaryKey === undefined) {
		throw new Error("EMDASH_ENCRYPTION_KEY is empty");
	}
	await repo.set(SMTP_OPTION_PASSWORD, await encrypt(config.pass, primaryKey));
	if (config.fromName) {
		await repo.set(`${SMTP_OPTION_PREFIX}fromName`, config.fromName);
	} else {
		await repo.delete(`${SMTP_OPTION_PREFIX}fromName`);
	}
	if (config.fromEmail) {
		await repo.set(`${SMTP_OPTION_PREFIX}fromEmail`, config.fromEmail);
	} else {
		await repo.delete(`${SMTP_OPTION_PREFIX}fromEmail`);
	}
	if (config.replyTo) {
		await repo.set(`${SMTP_OPTION_PREFIX}replyTo`, config.replyTo);
	} else {
		await repo.delete(`${SMTP_OPTION_PREFIX}replyTo`);
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
	await repo.delete(`${SMTP_OPTION_PREFIX}fromName`);
	await repo.delete(`${SMTP_OPTION_PREFIX}fromEmail`);
	await repo.delete(`${SMTP_OPTION_PREFIX}replyTo`);
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

/**
 * A partial config (host but no password, e.g. a half-saved form) must not
 * even attempt delivery — the resulting 535 is more confusing than a clear
 * "not fully configured" error.
 */
export function isSmtpConfigComplete(config: SmtpConfig | null): config is SmtpConfig {
	return Boolean(config?.host && config?.port && config?.user && config?.pass);
}

/** Deliver one message over SMTP. Throws on any protocol or network error. */
export async function deliverSmtp(
	config: SmtpConfig,
	message: EmailDeliverEvent["message"],
	ctx: PluginContext,
	connectFn?: ConnectFn,
): Promise<void> {
	if (config.port === 25) {
		throw new SmtpDeliveryError(
			"SMTP port 25 is not supported: Cloudflare blocks outbound port 25. " +
				"Use 587 (STARTTLS) or 465 (implicit TLS) instead.",
		);
	}
	const from = {
		email: config.fromEmail ?? config.user,
		...(config.fromName ? { name: config.fromName } : {}),
	};
	assertEnvelopeAddress(from.email, "sender");
	assertEnvelopeAddress(message.to, "recipient");
	// SMTP timeout must be SHORTER than the hook timeout, otherwise the hook
	// kills the promise before we can log the transcript. 25s vs 30s hook.
	const timeoutMs = config.timeoutMs ?? 25_000;

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
	// A throw inside setTimeout never reaches the awaiting promise — it becomes
	// an unhandled exception while the real delivery keeps hanging until the
	// hook timeout kills it, with no SMTP trace. Race a rejecting timeout
	// promise instead, and race the connect too: a blackholed host must fail
	// with the same timeout error rather than hanging in connect().
	let fail!: (error: Error) => void;
	const timeout = new Promise<never>((_, reject) => {
		fail = reject;
	});
	const timer = setTimeout(() => {
		socket?.close().catch(() => {});
		fail(new SmtpDeliveryError(`SMTP operation timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const trace = new SmtpTrace();
	// Held outside the race so a connect that resolves after the timeout
	// still gets closed (see finally) instead of leaking the socket.
	const connecting = connect(config.host, config.port, config.secure);
	try {
		// connect() runs outside deliver() so TS's control-flow analysis sees the
		// socket assignment (closure assignments make `socket` narrow to never).
		socket = await Promise.race([connecting, timeout]);
		return await Promise.race([deliver(socket), timeout]);
	} catch (error) {
		// The transcript goes to the server logs only — a bare "Hook timeout"
		// or "connection closed" says nothing about which step stalled. The
		// thrown error carries just the humanized message, safe to surface.
		const detail = error instanceof Error ? error.message : String(error);
		ctx.log.error("SMTP delivery failed", {
			error: detail,
			host: config.host,
			port: config.port,
			trace: trace.tail(),
		});
		throw error instanceof SmtpDeliveryError
			? error
			: new SmtpDeliveryError(detail, { cause: error });
	} finally {
		clearTimeout(timer);
		await socket?.close().catch(() => {});
		void connecting
			.then((late) => {
				if (late !== socket) void late.close().catch(() => {});
				return undefined;
			})
			.catch(() => {});
	}

	async function deliver(sock: SmtpSocket): Promise<void> {
		let active = sock;
		const buffered: Uint8Array[] = [];

		const send = async (line: string, sensitive = false) => {
			trace.record("send", line, sensitive);
			await active.writer.write(encodeUtf8(`${line}\r\n`));
		};
		const recv = async (context: string, expected: number | number[]) => {
			const reply = await readReply(active.reader, buffered);
			trace.record("recv", reply.lines.join(" / "));
			expectCode(reply, expected, context);
			return reply;
		};

		// Greeting
		await recv("greeting", 220);

		// EHLO
		await send(`EHLO emdash`);
		await recv("EHLO", 250);

		// STARTTLS upgrade
		if (config.secure === "starttls") {
			if (!active.startTls)
				throw new Error("STARTTLS requested but socket does not support upgrade");
			await send("STARTTLS");
			await recv("STARTTLS", 220);
			active = await active.startTls();
			socket = active; // close the upgraded socket on timeout
			buffered.length = 0;
			// Re-EHLO after TLS upgrade
			await send(`EHLO emdash`);
			await recv("EHLO after STARTTLS", 250);
		}

		// AUTH LOGIN — credentials are redacted from the trace
		await send("AUTH LOGIN");
		await recv("AUTH LOGIN", 334);
		await send(b64(config.user), true);
		await recv("AUTH username", 334);
		await send(b64(config.pass), true);
		await recv("AUTH password", 235);

		// Envelope
		await send(`MAIL FROM:<${from.email}>`);
		await recv("MAIL FROM", 250);
		await send(`RCPT TO:<${message.to}>`);
		await recv("RCPT TO", [250, 251]);

		// Data
		await send("DATA");
		await recv("DATA", 354);
		const mime = buildMime({
			from,
			...(config.replyTo ? { replyTo: config.replyTo } : {}),
			to: message.to,
			subject: message.subject,
			text: message.text,
			...(message.html ? { html: message.html } : {}),
		});
		await active.writer.write(encodeUtf8(`${mime}\r\n.\r\n`));
		await recv("message accepted", 250);

		// Quit
		await send("QUIT");

		ctx.log.info("email delivered via SMTP", {
			to: message.to,
			subject: message.subject,
			host: config.host,
			port: config.port,
		});
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

/**
 * Build an email:deliver handler that loads the SMTP config lazily on
 * every send — DB config first (when an encryption key is available to
 * decrypt the stored password), env vars as fallback. Loading per send
 * makes admin-saved settings work immediately, no runtime restart.
 */
export function createSmtpEmailDeliverFromDb(
	db: Kysely<Database>,
	encryptionKey: string | null,
	connectFn?: ConnectFn,
): (event: EmailDeliverEvent, ctx: PluginContext) => Promise<void> {
	return async (event, ctx) => {
		const config = encryptionKey
			? await loadSmtpConfig(db, encryptionKey)
			: loadSmtpConfigFromEnv();
		if (!isSmtpConfigComplete(config)) {
			throw new SmtpDeliveryError(
				"SMTP is not configured. Save host, port, username and password in Settings → Email.",
			);
		}
		return deliverSmtp(config, event.message, ctx, connectFn);
	};
}
