/**
 * Built-in SMTP Email Transport
 *
 * Delivers EmDash emails through any standard SMTP server (Brevo relay,
 * Office365, Google Workspace, Fastmail, Amazon SES, self-hosted Postfix).
 *
 * Registered as a built-in `email:deliver` provider. It uses `node:net` and
 * `node:tls`, which Cloudflare Workers provide under `nodejs_compat`.
 * Configuration comes from env vars (see below) or the Settings → Email
 * admin UI (stored encrypted in the database).
 *
 * Env vars:
 *   EMAIL_SMTP_HOST        smtp-relay.brevo.com
 *   EMAIL_SMTP_PORT        587 (STARTTLS) or 465 (implicit TLS)
 *   EMAIL_SMTP_SECURE      "starttls" | "tls"  (default: inferred from port)
 *   EMAIL_SMTP_USER        you@example.com
 *   EMAIL_SMTP_PASS        xsmtpsib-…
 *   EMAIL_SMTP_FROM        Site <noreply@example.com>  (optional default sender)
 *   EMAIL_SMTP_FROM_NAME   Site  (optional, with EMAIL_SMTP_FROM_EMAIL)
 *   EMAIL_SMTP_FROM_EMAIL  noreply@example.com  (optional, overrides EMAIL_SMTP_FROM)
 *   EMAIL_SMTP_REPLY_TO    support@example.com  (optional)
 *
 * Port 25 is refused with a clear error (Cloudflare and most hosts block it).
 * TLS is always required; plaintext auth is never attempted.
 */

import type { Socket } from "node:net";
import type { connect as tlsConnectFn } from "node:tls";

import type { Kysely } from "kysely";

import { parseEncryptionKeys } from "../config/secrets.js";
import { OptionsRepository } from "../database/repositories/options.js";
import { withTransaction } from "../database/transaction.js";
import type { Database } from "../database/types.js";
import {
	decryptPluginSetting,
	encryptPluginSetting,
	isEncryptedPluginSetting,
} from "./settings.js";
import type { EmailDeliverEvent, PluginContext } from "./types.js";

/**
 * Plugin ID for the built-in SMTP email provider. Distinct from the
 * community `emdash-smtp` plugin, which sites may run alongside it.
 */
export const SMTP_EMAIL_PLUGIN_ID = "emdash-builtin-smtp";

/** Options key prefix for SMTP settings */
const SMTP_OPTION_PREFIX = "emdash:email:smtp:";
const SMTP_OPTION_PASSWORD = `${SMTP_OPTION_PREFIX}password`;

// ---------------------------------------------------------------------------
// Socket layer
// ---------------------------------------------------------------------------

/** Longest reply line accepted from the server, in bytes. */
const SMTP_LINE_LIMIT = 8192;

interface SmtpReply {
	code: number;
	lines: string[];
}

export interface SmtpSocket {
	/** Next complete (possibly multi-line) server reply. */
	readReply(): Promise<SmtpReply>;
	write(data: string): Promise<void>;
	/**
	 * Send STARTTLS and, when the server answers 220, upgrade the connection
	 * to TLS. Resolves with the server's reply once the handshake is done.
	 */
	startTls(): Promise<SmtpReply>;
	destroy(): void;
}

export type ConnectFn = (
	host: string,
	port: number,
	secure: "starttls" | "tls",
	signal: AbortSignal,
) => Promise<SmtpSocket>;

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

function isWorkerd(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.userAgent === "string" &&
		navigator.userAgent.includes("Cloudflare-Workers")
	);
}

/**
 * TLS options naming the server. Node only sends SNI when `servername` is
 * set, but workerd rejects `servername` and derives SNI from `host` itself.
 */
function tlsServerName(host: string, isIp: boolean): { host: string; servername?: string } {
	return isWorkerd() || isIp ? { host } : { host, servername: host };
}

/**
 * Wrap a connected socket in the reply reader the SMTP session uses.
 * Replies are parsed inside the 'data' handler so STARTTLS can hand the
 * socket to TLS from that same handler.
 */
function wrapNodeSocket(
	initial: Socket,
	host: string,
	tlsConnect: typeof tlsConnectFn,
	isIp: boolean,
): SmtpSocket {
	let current = initial;
	let pending: Uint8Array = new Uint8Array(0);
	let lines: string[] = [];
	const replies: SmtpReply[] = [];
	let waiter: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | null = null;
	let failure: Error | null = null;

	const fail = (error: Error) => {
		if (failure) return;
		failure = error;
		const w = waiter;
		waiter = null;
		w?.reject(error);
		current.destroy();
	};
	const onData = (chunk: Uint8Array) => {
		pending = concat([pending, chunk]);
		for (let idx = indexOfCrlf(pending); idx >= 0; idx = indexOfCrlf(pending)) {
			const line = decodeUtf8(pending.subarray(0, idx));
			pending = pending.slice(idx + 2);
			lines.push(line);
			// "250-..." continues a multi-line reply, "250 ..." ends it
			if (line[3] === "-") continue;
			const reply = { code: Number.parseInt(lines[0]?.slice(0, 3) ?? "", 10), lines };
			lines = [];
			const w = waiter;
			waiter = null;
			if (w) w.resolve(reply);
			else replies.push(reply);
		}
		if (pending.length > SMTP_LINE_LIMIT) fail(new SmtpDeliveryError("SMTP line too long"));
	};
	const onEnd = () => fail(new SmtpDeliveryError("SMTP connection closed unexpectedly"));
	const attach = (sock: Socket) => {
		sock.on("data", onData);
		sock.on("end", onEnd);
		sock.on("close", onEnd);
		sock.on("error", fail);
	};
	const detach = (sock: Socket) => {
		sock.off("data", onData);
		sock.off("end", onEnd);
		sock.off("close", onEnd);
		sock.off("error", fail);
	};
	attach(initial);

	const write = (data: string) =>
		new Promise<void>((resolve, reject) => {
			if (failure) {
				reject(failure);
				return;
			}
			current.write(encodeUtf8(data), (error) => {
				if (error) reject(error);
				else resolve();
			});
		});

	return {
		readReply: () =>
			new Promise((resolve, reject) => {
				const queued = replies.shift();
				if (queued) return resolve(queued);
				if (failure) return reject(failure);
				waiter = { resolve, reject };
			}),
		write,
		startTls: () =>
			new Promise((resolve, reject) => {
				if (replies.length > 0) {
					return reject(new SmtpDeliveryError("SMTP server sent an unexpected reply"));
				}
				waiter = {
					reject,
					resolve: (reply) => {
						if (reply.code !== 220) return resolve(reply);
						// Bytes after the 220 arrived in plaintext and would be read as
						// if they came over TLS (STARTTLS command injection).
						if (pending.length > 0) {
							const error = new SmtpDeliveryError("SMTP server sent data after STARTTLS");
							reject(error);
							fail(error);
							return;
						}
						const plain = current;
						detach(plain);
						// Errors of the plain socket surface on the TLS socket.
						plain.on("error", () => {});
						// workerd only lets TLS take over the socket synchronously, inside
						// the 'data' handler that delivered the 220.
						const secured = tlsConnect({ socket: plain, ...tlsServerName(host, isIp) });
						current = secured;
						attach(secured);
						const handshake = { resolve: () => {}, reject };
						waiter = handshake;
						secured.once("secureConnect", () => {
							if (waiter === handshake) waiter = null;
							resolve(reply);
						});
					},
				};
				write("STARTTLS\r\n").catch(reject);
			}),
		destroy: () => current.destroy(),
	};
}

/** Open an SMTP connection over `node:net` (STARTTLS) or `node:tls` (implicit TLS). */
export const connectSmtpSocket: ConnectFn = async (host, port, secure, signal) => {
	// Loaded on first send, which keeps node:tls off the cold-start path.
	const [{ connect: netConnect, isIP }, { connect: tlsConnect }] = await Promise.all([
		import("node:net"),
		import("node:tls"),
	]);
	signal.throwIfAborted();
	const isIp = isIP(host) !== 0;
	return new Promise((resolve, reject) => {
		const sock: Socket =
			secure === "tls"
				? tlsConnect({ port, ...tlsServerName(host, isIp) })
				: netConnect({ host, port });
		const onAbort = () => {
			sock.destroy();
			reject(signal.reason);
		};
		const onError = (error: Error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		sock.once("error", onError);
		sock.once(secure === "tls" ? "secureConnect" : "connect", () => {
			signal.removeEventListener("abort", onAbort);
			sock.off("error", onError);
			const smtp = wrapNodeSocket(sock, host, tlsConnect, isIp);
			signal.addEventListener("abort", () => smtp.destroy(), { once: true });
			resolve(smtp);
		});
	});
};

/**
 * Map raw SMTP failures to actionable messages.
 * The raw server line stays in the message so support can still see it.
 */
function humanizeSmtpError(code: number, context: string, serverLine: string): string {
	const raw = `${code} ${serverLine}`.trim();
	if (code === 535) {
		return (
			`Authentication failed (${raw}). Username or password rejected by the server. ` +
			`Some providers require an SMTP key or app password instead of the account password.`
		);
	}
	if (code === 530) {
		return `Authentication required (${raw}). Check the SMTP username and password.`;
	}
	if (code === 550) {
		return (
			`Mailbox unavailable (${raw}). The server rejected the sender or recipient. ` +
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
	if (!(reply.code >= 200 && reply.code < 600)) {
		// The reply is not SMTP, so the host is another kind of service. Its
		// banner is logged with the transcript but never returned to the client.
		throw new SmtpDeliveryError(`SMTP ${context} failed: the server did not reply with SMTP`);
	}
	if (!codes.includes(reply.code)) {
		const serverLine = reply.lines.join(" | ");
		throw new SmtpDeliveryError(humanizeSmtpError(reply.code, context, serverLine));
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

	/** Last few events: enough context to see where the conversation stalled. */
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

/** RFC 2047 encoded-word for UTF-8 headers (Subject and display names). */
// RFC 2047 caps an encoded-word at 75 octets and forbids splitting a
// multi-byte character across two words. 36 UTF-8 bytes become 48 base64
// chars, which plus the `=?UTF-8?B?…?=` wrapper stays within the cap; the
// receiver concatenates adjacent encoded-words.
const ENCODED_WORD_MAX_BYTES = 36;

function encodedWord(text: string): string {
	return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(text)))}?=`;
}

function encodeHeader(value: string): string {
	const sanitized = sanitizeHeader(value);
	// Only encode when non-ASCII is present: ASCII headers stay readable.
	if (!NON_ASCII_REGEX.test(sanitized)) return sanitized;
	const words: string[] = [];
	let chunk = "";
	let chunkBytes = 0;
	for (const char of sanitized) {
		const bytes = encodeUtf8(char).length;
		if (chunk && chunkBytes + bytes > ENCODED_WORD_MAX_BYTES) {
			words.push(encodedWord(chunk));
			chunk = "";
			chunkBytes = 0;
		}
		chunk += char;
		chunkBytes += bytes;
	}
	if (chunk) words.push(encodedWord(chunk));
	// Folding keeps each header line within the RFC 5322 length limits.
	return words.join("\r\n ");
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

/** RFC 5321 §4.5.2 transparency: double a period that starts a line of DATA. */
export function dotStuff(data: string): string {
	return data.replace(/^\./gm, "..");
}

/**
 * Build the MIME message. Bodies are base64-encoded and wrapped at 76
 * columns, so no line exceeds the SMTP 998-octet limit.
 */
function buildMime(params: {
	from: { email: string; name?: string };
	replyTo?: string;
	to: string;
	cc?: string[];
	subject: string;
	text: string;
	html?: string;
}): string {
	const { from, replyTo, to, cc, subject, text, html } = params;
	const headers: string[] = [
		`From: ${from.name ? formatNameAddress(from.name, from.email) : from.email}`,
		`To: ${sanitizeHeader(to)}`,
		...(cc?.length ? [`Cc: ${cc.map(sanitizeHeader).join(", ")}`] : []),
		`Subject: ${encodeHeader(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@${from.email.split("@")[1] || "emdash.invalid"}>`,
		`MIME-Version: 1.0`,
	];
	if (replyTo) {
		const { email, name } = parseAddress(replyTo);
		headers.push(`Reply-To: ${name ? formatNameAddress(name, email) : email}`);
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
	/** Connect + overall timeout in ms (default 25s) */
	timeoutMs?: number;
}

/** Load SMTP config from env; returns null if not configured. */
export function loadSmtpConfigFromEnv(): SmtpConfig | null {
	const host = process.env.EMAIL_SMTP_HOST;
	if (!host) return null;
	const portRaw = process.env.EMAIL_SMTP_PORT || "587";
	const port = Number(portRaw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`EMAIL_SMTP_PORT must be a port number from 1 to 65535, got "${portRaw}"`);
	}
	if (port === 25) {
		throw new Error(
			"EMAIL_SMTP_PORT=25 is not supported. Use 587 (STARTTLS) or 465 (implicit TLS) instead.",
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
	// The structured fields take precedence over EMAIL_SMTP_FROM.
	let fromName: string | undefined;
	let fromEmail: string | undefined;
	if (process.env.EMAIL_SMTP_FROM_EMAIL) {
		fromName = process.env.EMAIL_SMTP_FROM_NAME || undefined;
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

// Binding host and user into the encryption context means a password from a
// partially written save never decrypts for a different server or login.
function passwordSettingKey(host: string, user: string): string {
	return JSON.stringify(["password", host, user]);
}

/** Load SMTP config from DB, decrypting the password with the encryption key. */
export async function loadSmtpConfigFromDb(
	db: Kysely<Database>,
	encryptionKey: string,
): Promise<SmtpConfig | null> {
	const repo = new OptionsRepository(db);
	// One round trip for all fields: this runs on every send.
	const values = await repo.getMany([
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
	const encryptedPass = values.get(SMTP_OPTION_PASSWORD);
	const fromName = str(`${SMTP_OPTION_PREFIX}fromName`);
	const fromEmail = str(`${SMTP_OPTION_PREFIX}fromEmail`);
	const replyTo = str(`${SMTP_OPTION_PREFIX}replyTo`);

	if (!host || !port || !secure || !user || !isEncryptedPluginSetting(encryptedPass)) {
		return null;
	}
	if (port === 25) {
		console.warn(
			"[email-smtp] Stored SMTP port 25 is not supported: save 587 or 465 in Settings → Email.",
		);
		return null;
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.warn(
			`[email-smtp] Stored SMTP port ${port} is not a valid port number: ` +
				"save a whole number between 1 and 65535 in Settings → Email.",
		);
		return null;
	}

	let pass: string;
	try {
		pass = await decryptPluginSetting(
			SMTP_EMAIL_PLUGIN_ID,
			passwordSettingKey(host, user),
			encryptedPass,
			await parseEncryptionKeys(encryptionKey),
		);
	} catch {
		console.warn(
			"[email-smtp] Stored SMTP password cannot be decrypted for this host and username " +
				"with the configured encryption key(s): re-save the password in Settings → Email.",
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
	const password = await encryptPluginSetting(
		SMTP_EMAIL_PLUGIN_ID,
		passwordSettingKey(config.host, config.user),
		config.pass,
		await parseEncryptionKeys(encryptionKey),
	);
	const optional = {
		fromName: config.fromName,
		fromEmail: config.fromEmail,
		replyTo: config.replyTo,
	};
	await withTransaction(db, async (trx) => {
		const repo = new OptionsRepository(trx);
		await repo.set(`${SMTP_OPTION_PREFIX}host`, config.host);
		await repo.set(`${SMTP_OPTION_PREFIX}port`, config.port);
		await repo.set(`${SMTP_OPTION_PREFIX}secure`, config.secure);
		await repo.set(`${SMTP_OPTION_PREFIX}user`, config.user);
		await repo.set(SMTP_OPTION_PASSWORD, password);
		for (const [field, value] of Object.entries(optional)) {
			if (value) await repo.set(`${SMTP_OPTION_PREFIX}${field}`, value);
		}
		const cleared = Object.entries(optional)
			.filter(([, value]) => !value)
			.map(([field]) => `${SMTP_OPTION_PREFIX}${field}`);
		if (cleared.length > 0) await repo.deleteMany(cleared);
	});
}

/**
 * Load SMTP config from DB first, then fall back to env vars.
 * Returns null if neither is configured.
 *
 * DB settings take precedence so admin changes apply without a restart, so
 * every send reads the options table, even when only env vars are set.
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
 * even attempt delivery: the resulting 535 is more confusing than a clear
 * "not fully configured" error.
 */
export function isSmtpConfigComplete(config: SmtpConfig | null): config is SmtpConfig {
	return Boolean(config?.host && config?.port && config?.user && config?.pass);
}

/** Whether env vars hold a complete SMTP config. Logs why an invalid env config is ignored. */
export function isSmtpEnvConfigured(): boolean {
	try {
		return isSmtpConfigComplete(loadSmtpConfigFromEnv());
	} catch (error) {
		console.warn(
			`[email-smtp] Ignoring SMTP environment variables: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

const EHLO_PARAM_SEPARATOR = /[\s=]+/;

/** EHLO keywords mapped to their parameters ("AUTH LOGIN PLAIN" and legacy "AUTH=LOGIN"). */
function parseEhloExtensions(reply: SmtpReply): Map<string, string[]> {
	const extensions = new Map<string, string[]>();
	for (const line of reply.lines.slice(1)) {
		const [keyword, ...params] = line.slice(4).toUpperCase().split(EHLO_PARAM_SEPARATOR);
		if (keyword) extensions.set(keyword, [...(extensions.get(keyword) ?? []), ...params]);
	}
	return extensions;
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
			"SMTP port 25 is not supported. Use 587 (STARTTLS) or 465 (implicit TLS) instead.",
		);
	}
	const from = {
		email: config.fromEmail ?? config.user,
		...(config.fromName ? { name: config.fromName } : {}),
	};
	assertEnvelopeAddress(from.email, "sender");
	const recipients = [message.to, ...(message.cc ?? [])];
	for (const recipient of recipients) assertEnvelopeAddress(recipient, "recipient");
	const replyTo = message.replyTo ?? config.replyTo;
	if (replyTo) assertEnvelopeAddress(parseAddress(replyTo).email, "reply-to");
	// SMTP timeout must be SHORTER than the hook timeout, otherwise the hook
	// kills the promise before we can log the transcript. 25s vs 30s hook.
	const timeoutMs = config.timeoutMs ?? 25_000;
	// Strict servers reject an EHLO name that is not a fully qualified domain.
	const ehloName = from.email.slice(from.email.lastIndexOf("@") + 1);

	const connect = connectFn ?? connectSmtpSocket;
	const controller = new AbortController();
	const aborted = new Promise<never>((_, reject) => {
		controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
			once: true,
		});
	});
	const timer = setTimeout(() => {
		controller.abort(new SmtpDeliveryError(`SMTP operation timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const trace = new SmtpTrace();
	let socket: SmtpSocket | undefined;
	try {
		try {
			socket = await Promise.race([
				connect(config.host, config.port, config.secure, controller.signal),
				aborted,
			]);
		} catch (error) {
			if (controller.signal.aborted) throw error;
			const code =
				error instanceof Error && "code" in error && typeof error.code === "string"
					? ` (${error.code})`
					: "";
			throw new SmtpDeliveryError(
				`Failed to connect to SMTP server ${config.host}:${config.port}${code}`,
				{ cause: error },
			);
		}
		return await Promise.race([deliver(socket), aborted]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.log.error("SMTP delivery failed", {
			error: detail,
			host: config.host,
			port: config.port,
			trace: trace.tail(),
		});
		if (error instanceof SmtpDeliveryError) throw error;
		// The raw message may contain internals; it is only logged above.
		const code =
			error instanceof Error && "code" in error && typeof error.code === "string"
				? ` (${error.code})`
				: "";
		throw new SmtpDeliveryError(`SMTP delivery via ${config.host}:${config.port} failed${code}`, {
			cause: error,
		});
	} finally {
		clearTimeout(timer);
		socket?.destroy();
	}

	async function deliver(sock: SmtpSocket): Promise<void> {
		const send = async (line: string, sensitive = false) => {
			trace.record("send", line, sensitive);
			await sock.write(`${line}\r\n`);
		};
		const check = (reply: SmtpReply, context: string, expected: number | number[]) => {
			trace.record("recv", reply.lines.join(" / "));
			expectCode(reply, expected, context);
			return reply;
		};
		const recv = async (context: string, expected: number | number[]) =>
			check(await sock.readReply(), context, expected);

		await recv("greeting", 220);

		await send(`EHLO ${ehloName}`);
		let extensions = parseEhloExtensions(await recv("EHLO", 250));

		if (config.secure === "starttls") {
			if (!extensions.has("STARTTLS")) {
				throw new SmtpDeliveryError(
					`${config.host} does not offer STARTTLS on port ${config.port}. ` +
						"Use port 465 (implicit TLS) instead.",
				);
			}
			trace.record("send", "STARTTLS");
			check(await sock.startTls(), "STARTTLS", 220);
			await send(`EHLO ${ehloName}`);
			extensions = parseEhloExtensions(await recv("EHLO after STARTTLS", 250));
		}

		// Credentials are redacted from the trace
		const mechanisms = extensions.get("AUTH") ?? [];
		if (mechanisms.includes("PLAIN")) {
			await send(`AUTH PLAIN ${b64(`\0${config.user}\0${config.pass}`)}`, true);
			await recv("AUTH PLAIN", 235);
		} else if (mechanisms.includes("LOGIN")) {
			await send("AUTH LOGIN");
			await recv("AUTH LOGIN", 334);
			await send(b64(config.user), true);
			await recv("AUTH username", 334);
			await send(b64(config.pass), true);
			await recv("AUTH password", 235);
		} else {
			throw new SmtpDeliveryError(
				mechanisms.length > 0
					? `${config.host} offers no supported login method (${mechanisms.join(", ")}). ` +
							"EmDash supports PLAIN and LOGIN."
					: `${config.host} does not offer authentication on this connection.`,
			);
		}

		// Envelope
		await send(`MAIL FROM:<${from.email}>`);
		await recv("MAIL FROM", 250);
		for (const recipient of recipients) {
			await send(`RCPT TO:<${recipient}>`);
			await recv("RCPT TO", [250, 251]);
		}

		// Data
		await send("DATA");
		await recv("DATA", 354);
		const mime = buildMime({
			from,
			...(replyTo ? { replyTo } : {}),
			to: message.to,
			...(message.cc?.length ? { cc: message.cc } : {}),
			subject: message.subject,
			text: message.text,
			...(message.html ? { html: message.html } : {}),
		});
		await sock.write(`${dotStuff(mime)}\r\n.\r\n`);
		await recv("message accepted", 250);

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
 * Build an email:deliver handler that loads the SMTP config lazily on
 * every send: DB config first (when an encryption key is available to
 * decrypt the stored password), env vars as fallback. Loading per send
 * makes admin-saved settings work immediately, no runtime restart.
 */
export function createSmtpEmailDeliverFromDb(
	getDb: () => Kysely<Database>,
	encryptionKey: string | null,
	connectFn?: ConnectFn,
): (event: EmailDeliverEvent, ctx: PluginContext) => Promise<void> {
	return async (event, ctx) => {
		const config = encryptionKey
			? await loadSmtpConfig(getDb(), encryptionKey)
			: loadSmtpConfigFromEnv();
		if (!isSmtpConfigComplete(config)) {
			throw new SmtpDeliveryError(
				"SMTP is not configured. Save host, port, username and password in Settings → Email.",
			);
		}
		return deliverSmtp(config, event.message, ctx, connectFn);
	};
}
