import type { PublisherOAuthPurpose } from "../oauth/custody.js";
import type {
	PublisherDurableObject,
	StoredPublisherSession,
} from "../publisher-do/publisher-do.js";

const SESSION_COOKIE = "__Host-emdash_publisher_session";
const CSRF_COOKIE = "__Host-emdash_publisher_csrf";
const OAUTH_ROUTE_COOKIE = "__Host-emdash_oauth_route";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING_PATTERN = /=+$/;
const SESSION_TOKEN_BYTES = 32;
const SESSION_LIFETIME_MS = 60 * 60_000;
const OAUTH_ROUTE_LIFETIME_MS = 10 * 60_000;
const MAX_COOKIE_HEADER_CHARS = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Did = `did:${string}:${string}`;

export type PublisherSessionErrorCode =
	| "PUBLISHER_SESSION_INVALID"
	| "PUBLISHER_SESSION_EXPIRED"
	| "PUBLISHER_SUSPENDED"
	| "CSRF_INVALID"
	| "ORIGIN_INVALID";

export class PublisherSessionError extends Error {
	readonly code: PublisherSessionErrorCode;

	constructor(code: PublisherSessionErrorCode) {
		super(code);
		this.name = "PublisherSessionError";
		this.code = code;
	}
}

export interface CreatedPublisherSession {
	session: StoredPublisherSession;
	setCookieHeaders: readonly [string, string];
}

export interface OAuthRouteState {
	purpose: PublisherOAuthPurpose;
	expectedDid: Did;
	redirectTarget: string;
	stateId: string;
	expiresAt: number;
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
	const digest = await hashOpaqueBytes(value);
	return encodeBase64Url(new Uint8Array(digest));
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
	if (!bytes || bytes.length > 4096) throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	try {
		return JSON.parse(decoder.decode(bytes));
	} catch {
		throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	}
}

function parseCookies(request: Request): ReadonlyMap<string, string> {
	const header = request.headers.get("cookie") ?? "";
	if (header.length > MAX_COOKIE_HEADER_CHARS) {
		throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	}
	const cookies = new Map<string, string>();
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (cookies.has(name)) throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
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

function parsePublisherSessionCookie(value: string): { did: Did; token: string } {
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
		throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	}
	return { did: parsed.did, token: parsed.token };
}

export async function createPublisherApplicationSession(
	namespace: DurableObjectNamespace<PublisherDurableObject>,
	publisherDid: Did,
	now = Date.now(),
): Promise<CreatedPublisherSession> {
	if (!DID_PATTERN.test(publisherDid) || !Number.isSafeInteger(now)) {
		throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	}
	const token = randomToken();
	const csrf = randomToken();
	const expiresAt = now + SESSION_LIFETIME_MS;
	const result = await namespace.getByName(publisherDid).createPublisherSession({
		publisherDid,
		tokenHash: await hashOpaque(token),
		csrfHash: await hashOpaque(csrf),
		expiresAt,
		now,
	});
	if (!result.ok) {
		throw new PublisherSessionError(
			result.code === "PUBLISHER_SUSPENDED" ? "PUBLISHER_SUSPENDED" : "PUBLISHER_SESSION_INVALID",
		);
	}
	return {
		session: result.session,
		setCookieHeaders: [
			serializeCookie(SESSION_COOKIE, encodeJsonCookie({ v: 1, did: publisherDid, token }), {
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

export async function requirePublisherApplicationSession(
	request: Request,
	namespace: DurableObjectNamespace<PublisherDurableObject>,
	publicOrigin: string,
	options: { requireCsrf?: boolean } = {},
): Promise<StoredPublisherSession> {
	const cookies = parseCookies(request);
	const sessionCookie = cookies.get(SESSION_COOKIE);
	if (!sessionCookie) throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	const parsed = parsePublisherSessionCookie(sessionCookie);
	let csrfHash: string | null = null;
	if (options.requireCsrf) {
		if (
			request.headers.get("origin") !== publicOrigin ||
			request.headers.get("x-emdash-request") !== "1"
		) {
			throw new PublisherSessionError("ORIGIN_INVALID");
		}
		const csrfCookie = cookies.get(CSRF_COOKIE);
		const csrfHeader = request.headers.get("x-emdash-csrf");
		if (!csrfCookie || !csrfHeader || !TOKEN_PATTERN.test(csrfCookie)) {
			throw new PublisherSessionError("CSRF_INVALID");
		}
		const [cookieDigest, headerDigest] = await Promise.all([
			hashOpaqueBytes(csrfCookie),
			hashOpaqueBytes(csrfHeader),
		]);
		if (!crypto.subtle.timingSafeEqual(cookieDigest, headerDigest)) {
			throw new PublisherSessionError("CSRF_INVALID");
		}
		csrfHash = encodeBase64Url(new Uint8Array(headerDigest));
	}
	const result = await namespace
		.getByName(parsed.did)
		.validatePublisherSession(parsed.did, await hashOpaque(parsed.token), csrfHash);
	if (!result.ok) throw new PublisherSessionError(result.code);
	return result.session;
}

export function clearPublisherSessionCookies(): readonly [string, string] {
	return [
		serializeCookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0 }),
		serializeCookie(CSRF_COOKIE, "", {
			httpOnly: false,
			maxAge: 0,
			sameSite: "Strict",
		}),
	];
}

export function createOAuthRouteCookie(
	input: Omit<OAuthRouteState, "expiresAt">,
	now = Date.now(),
): string {
	if (
		!DID_PATTERN.test(input.expectedDid) ||
		!BASE64URL_PATTERN.test(input.stateId) ||
		input.stateId.length < 16 ||
		input.stateId.length > 128 ||
		!Number.isSafeInteger(now)
	) {
		throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	}
	return serializeCookie(
		OAUTH_ROUTE_COOKIE,
		encodeJsonCookie({ v: 1, ...input, expiresAt: now + OAUTH_ROUTE_LIFETIME_MS }),
		{ httpOnly: true, maxAge: OAUTH_ROUTE_LIFETIME_MS / 1000 },
	);
}

export function readOAuthRouteCookie(
	request: Request,
	callbackState: string,
	now = Date.now(),
): OAuthRouteState {
	const cookie = parseCookies(request).get(OAUTH_ROUTE_COOKIE);
	if (!cookie || !BASE64URL_PATTERN.test(callbackState) || !Number.isSafeInteger(now)) {
		throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	}
	const parsed = decodeJsonCookie(cookie);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		Object.keys(parsed).length !== 6 ||
		!("v" in parsed) ||
		parsed.v !== 1 ||
		!("purpose" in parsed) ||
		(parsed.purpose !== "publisher_identity" &&
			parsed.purpose !== "approver_identity" &&
			parsed.purpose !== "release_delegation") ||
		!("expectedDid" in parsed) ||
		!isDid(parsed.expectedDid) ||
		!("redirectTarget" in parsed) ||
		typeof parsed.redirectTarget !== "string" ||
		!("stateId" in parsed) ||
		typeof parsed.stateId !== "string" ||
		parsed.stateId !== callbackState ||
		!("expiresAt" in parsed) ||
		typeof parsed.expiresAt !== "number" ||
		!Number.isSafeInteger(parsed.expiresAt) ||
		parsed.expiresAt <= now
	) {
		throw new PublisherSessionError("PUBLISHER_SESSION_INVALID");
	}
	return {
		purpose: parsed.purpose,
		expectedDid: parsed.expectedDid,
		redirectTarget: parsed.redirectTarget,
		stateId: parsed.stateId,
		expiresAt: parsed.expiresAt,
	};
}

export function clearOAuthRouteCookie(): string {
	return serializeCookie(OAUTH_ROUTE_COOKIE, "", { httpOnly: true, maxAge: 0 });
}
