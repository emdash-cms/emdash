import type { ApproverDurableObject, StoredApproverSession } from "../approver-do/approver-do.js";

const SESSION_COOKIE = "__Host-emdash_approver_session";
const CSRF_COOKIE = "__Host-emdash_approver_csrf";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING_PATTERN = /=+$/;
const SESSION_TOKEN_BYTES = 32;
const SESSION_LIFETIME_MS = 60 * 60_000;
const MAX_COOKIE_HEADER_CHARS = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Did = `did:${string}:${string}`;

export type ApproverSessionErrorCode =
	| "APPROVER_SESSION_INVALID"
	| "APPROVER_SESSION_EXPIRED"
	| "APPROVER_SUSPENDED"
	| "CSRF_INVALID"
	| "ORIGIN_INVALID";

export class ApproverSessionError extends Error {
	constructor(readonly code: ApproverSessionErrorCode) {
		super(code);
		this.name = "ApproverSessionError";
	}
}

export interface CreatedApproverSession {
	session: StoredApproverSession;
	setCookieHeaders: readonly [string, string];
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING_PATTERN, "");
}

function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!BASE64URL_PATTERN.test(value) ||
		value.length % 4 === 1
	) {
		return null;
	}
	try {
		const padded = value
			.replaceAll("-", "+")
			.replaceAll("_", "/")
			.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return encodeBase64Url(bytes) === value ? bytes : null;
	} catch {
		return null;
	}
}

function randomToken(): string {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

async function hashOpaque(value: string): Promise<string> {
	return encodeBase64Url(new Uint8Array(await hashOpaqueBytes(value)));
}

function hashOpaqueBytes(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

function encodeJsonCookie(value: unknown): string {
	return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

function isDid(value: unknown): value is Did {
	return typeof value === "string" && DID_PATTERN.test(value);
}

function decodeJsonCookie(value: string): unknown {
	const bytes = decodeBase64Url(value);
	if (!bytes || bytes.length > 4096) throw new ApproverSessionError("APPROVER_SESSION_INVALID");
	try {
		return JSON.parse(decoder.decode(bytes));
	} catch {
		throw new ApproverSessionError("APPROVER_SESSION_INVALID");
	}
}

function parseCookies(request: Request): ReadonlyMap<string, string> {
	const header = request.headers.get("cookie") ?? "";
	if (header.length > MAX_COOKIE_HEADER_CHARS) {
		throw new ApproverSessionError("APPROVER_SESSION_INVALID");
	}
	const cookies = new Map<string, string>();
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (cookies.has(name)) throw new ApproverSessionError("APPROVER_SESSION_INVALID");
		cookies.set(name, value);
	}
	return cookies;
}

function serializeCookie(
	name: string,
	value: string,
	options: { httpOnly: boolean; maxAge: number; sameSite?: "Lax" | "Strict" },
): string {
	return [
		`${name}=${value}`,
		"Path=/",
		`Max-Age=${options.maxAge}`,
		"Secure",
		options.httpOnly ? "HttpOnly" : null,
		`SameSite=${options.sameSite ?? "Lax"}`,
	]
		.filter((part): part is string => part !== null)
		.join("; ");
}

function parseSessionCookie(value: string): { did: Did; token: string } {
	const parsed = decodeJsonCookie(value);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		Object.keys(parsed).length !== 3 ||
		!("v" in parsed) ||
		parsed.v !== 1 ||
		!("did" in parsed) ||
		!isDid(parsed.did) ||
		!("token" in parsed) ||
		typeof parsed.token !== "string" ||
		!TOKEN_PATTERN.test(parsed.token)
	) {
		throw new ApproverSessionError("APPROVER_SESSION_INVALID");
	}
	return { did: parsed.did, token: parsed.token };
}

export async function createApproverApplicationSession(
	namespace: DurableObjectNamespace<ApproverDurableObject>,
	approverDid: Did,
	now = Date.now(),
): Promise<CreatedApproverSession> {
	if (!DID_PATTERN.test(approverDid) || !Number.isSafeInteger(now) || now < 0) {
		throw new ApproverSessionError("APPROVER_SESSION_INVALID");
	}
	const token = randomToken();
	const csrf = randomToken();
	const expiresAt = now + SESSION_LIFETIME_MS;
	const result = await namespace.getByName(approverDid).createApproverSession({
		approverDid,
		tokenHash: await hashOpaque(token),
		csrfHash: await hashOpaque(csrf),
		expiresAt,
		now,
	});
	if (!result.ok) {
		throw new ApproverSessionError(
			result.code === "APPROVER_SUSPENDED" ? "APPROVER_SUSPENDED" : "APPROVER_SESSION_INVALID",
		);
	}
	return {
		session: result.session,
		setCookieHeaders: [
			serializeCookie(SESSION_COOKIE, encodeJsonCookie({ v: 1, did: approverDid, token }), {
				httpOnly: true,
				maxAge: SESSION_LIFETIME_MS / 1000,
			}),
			serializeCookie(CSRF_COOKIE, csrf, {
				httpOnly: false,
				maxAge: SESSION_LIFETIME_MS / 1000,
				sameSite: "Strict",
			}),
		],
	};
}

export async function requireApproverApplicationSession(
	request: Request,
	namespace: DurableObjectNamespace<ApproverDurableObject>,
	publicOrigin: string,
	options: { requireCsrf?: boolean } = {},
): Promise<StoredApproverSession> {
	const cookies = parseCookies(request);
	const sessionCookie = cookies.get(SESSION_COOKIE);
	if (!sessionCookie) throw new ApproverSessionError("APPROVER_SESSION_INVALID");
	const parsed = parseSessionCookie(sessionCookie);
	let csrfHash: string | null = null;
	if (options.requireCsrf) {
		if (
			request.headers.get("origin") !== publicOrigin ||
			request.headers.get("x-emdash-request") !== "1"
		) {
			throw new ApproverSessionError("ORIGIN_INVALID");
		}
		const csrfCookie = cookies.get(CSRF_COOKIE);
		const csrfHeader = request.headers.get("x-emdash-csrf");
		if (
			!csrfCookie ||
			!csrfHeader ||
			!TOKEN_PATTERN.test(csrfCookie) ||
			!TOKEN_PATTERN.test(csrfHeader)
		) {
			throw new ApproverSessionError("CSRF_INVALID");
		}
		const [cookieDigest, headerDigest] = await Promise.all([
			hashOpaqueBytes(csrfCookie),
			hashOpaqueBytes(csrfHeader),
		]);
		if (!crypto.subtle.timingSafeEqual(cookieDigest, headerDigest)) {
			throw new ApproverSessionError("CSRF_INVALID");
		}
		csrfHash = encodeBase64Url(new Uint8Array(headerDigest));
	}
	const result = await namespace
		.getByName(parsed.did)
		.validateApproverSession(parsed.did, await hashOpaque(parsed.token), csrfHash);
	if (!result.ok) throw new ApproverSessionError(result.code);
	return result.session;
}

export function clearApproverSessionCookies(): readonly [string, string] {
	return [
		serializeCookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0 }),
		serializeCookie(CSRF_COOKIE, "", {
			httpOnly: false,
			maxAge: 0,
			sameSite: "Strict",
		}),
	];
}
