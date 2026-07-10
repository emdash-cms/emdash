import { verificationError } from "./errors.js";
import type { VerificationResult } from "./errors.js";

const DIGITS = /^\d+$/;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV4_PART = /^\d{1,3}$/;
const IPV6_PART = /^[0-9a-f]{1,4}$/i;

export const DEFAULT_FETCH_LIMITS = {
	headerTimeoutMs: 10_000,
	totalTimeoutMs: 30_000,
	maxBytes: 25 * 1024 * 1024,
	maxRedirects: 3,
} as const;

export type FetchImplementation = (input: URL, init: RequestInit) => Promise<Response>;
/**
 * Resolves every hostname before it is fetched. Returned addresses are checked
 * for local and private ranges. Workers cannot pin fetch() to these addresses,
 * so callers with private-network access must use an egress proxy that does.
 */
export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

export interface FetchVerifiedResourceOptions {
	fetch: FetchImplementation;
	resolveHostname: HostnameResolver;
	headerTimeoutMs?: number;
	totalTimeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
}

export interface VerifiedResource {
	bytes: Uint8Array;
	url: URL;
	status: number;
	headers: Headers;
}

export async function fetchVerifiedResource(
	value: string | URL,
	options: FetchVerifiedResourceOptions,
): Promise<VerificationResult<VerifiedResource>> {
	const limits = {
		headerTimeoutMs: options.headerTimeoutMs ?? DEFAULT_FETCH_LIMITS.headerTimeoutMs,
		totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_FETCH_LIMITS.totalTimeoutMs,
		maxBytes: options.maxBytes ?? DEFAULT_FETCH_LIMITS.maxBytes,
		maxRedirects: options.maxRedirects ?? DEFAULT_FETCH_LIMITS.maxRedirects,
	};
	if (!areValidLimits(limits))
		return verificationError("INVALID_URL", "Fetch limits must be positive integers.");

	const startedAt = Date.now();
	let currentUrl = parseAndValidateUrl(value);
	if (!currentUrl.success) return currentUrl;

	for (let redirects = 0; ; redirects += 1) {
		const remaining = limits.totalTimeoutMs - (Date.now() - startedAt);
		if (remaining <= 0)
			return verificationError(
				"RESOURCE_TIMEOUT",
				"The resource fetch exceeded its total timeout.",
			);
		const host = await validateHost(currentUrl.value, options.resolveHostname, remaining);
		if (!host.success) return host;

		const remainingAfterResolution = limits.totalTimeoutMs - (Date.now() - startedAt);
		if (remainingAfterResolution <= 0)
			return verificationError(
				"RESOURCE_TIMEOUT",
				"The resource fetch exceeded its total timeout.",
			);
		const response = await fetchResponse(
			options.fetch,
			currentUrl.value,
			Math.min(remainingAfterResolution, limits.headerTimeoutMs),
		);
		if (!response.success) return response;

		if (isRedirect(response.value.status)) {
			if (redirects >= limits.maxRedirects) {
				return verificationError(
					"REDIRECT_LIMIT_EXCEEDED",
					"The resource exceeded the redirect limit.",
				);
			}
			const location = response.value.headers.get("location");
			if (location === null) {
				return verificationError(
					"REDIRECT_LOCATION_MISSING",
					"The redirect response has no location header.",
				);
			}
			currentUrl = parseAndValidateUrl(location, currentUrl.value);
			if (!currentUrl.success) return currentUrl;
			continue;
		}

		if (!response.value.ok) {
			return verificationError(
				"RESOURCE_STATUS_ERROR",
				`The resource returned HTTP ${response.value.status}.`,
			);
		}
		const contentLength = response.value.headers.get("content-length");
		if (
			contentLength !== null &&
			(!DIGITS.test(contentLength) || Number(contentLength) > limits.maxBytes)
		) {
			return verificationError("RESOURCE_SIZE_EXCEEDED", "The resource exceeds the byte limit.");
		}

		const bytes = await readResponse(
			response.value,
			limits.maxBytes,
			startedAt,
			limits.totalTimeoutMs,
		);
		if (!bytes.success) return bytes;
		return {
			success: true,
			value: {
				bytes: bytes.value,
				url: currentUrl.value,
				status: response.value.status,
				headers: response.value.headers,
			},
		};
	}
}

function parseAndValidateUrl(value: string | URL, base?: URL): VerificationResult<URL> {
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		return verificationError("INVALID_URL", "The resource URL is invalid.");
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
		return verificationError(
			"INVALID_URL",
			"Resource URLs must use HTTPS and cannot include credentials.",
		);
	}
	if (isIpLiteral(url.hostname) || isLocalHostname(url.hostname)) {
		return verificationError("HOST_REJECTED", "The resource host is not permitted.");
	}
	return { success: true, value: url };
}

async function validateHost(
	url: URL,
	resolver: HostnameResolver,
	timeoutMs: number,
): Promise<VerificationResult<true>> {
	try {
		const addresses = await withTimeout(
			Promise.resolve().then(() => resolver(url.hostname)),
			timeoutMs,
		);
		if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
			return verificationError(
				"HOST_REJECTED",
				"The resource host resolved to a forbidden address.",
			);
		}
		return { success: true, value: true };
	} catch (error) {
		if (isAbortError(error)) {
			return verificationError(
				"RESOURCE_TIMEOUT",
				"The resource fetch exceeded its total timeout.",
			);
		}
		return verificationError("HOST_REJECTED", "The resource host could not be validated.");
	}
}

async function fetchResponse(
	fetchImplementation: FetchImplementation,
	url: URL,
	timeoutMs: number,
): Promise<VerificationResult<Response>> {
	const controller = new AbortController();
	try {
		return {
			success: true,
			value: await withTimeout(
				Promise.resolve().then(() =>
					fetchImplementation(url, {
						method: "GET",
						redirect: "manual",
						signal: controller.signal,
					}),
				),
				timeoutMs,
				() => controller.abort(),
			),
		};
	} catch (error) {
		if (controller.signal.aborted || isAbortError(error)) {
			return verificationError("RESOURCE_TIMEOUT", "The resource response headers timed out.");
		}
		return verificationError("FETCH_FAILED", "The resource request failed.");
	}
}

async function readResponse(
	response: Response,
	maximumBytes: number,
	startedAt: number,
	totalTimeoutMs: number,
): Promise<VerificationResult<Uint8Array>> {
	if (response.body === null) return { success: true, value: new Uint8Array() };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const remaining = totalTimeoutMs - (Date.now() - startedAt);
			if (remaining <= 0) {
				await reader.cancel();
				return verificationError(
					"RESOURCE_TIMEOUT",
					"The resource fetch exceeded its total timeout.",
				);
			}
			const chunk = await readWithTimeout(reader, remaining);
			if (!chunk.success) {
				await reader.cancel();
				return chunk;
			}
			if (chunk.value.done) break;
			const value = chunk.value.value;
			length += value.length;
			if (length > maximumBytes) {
				await reader.cancel();
				return verificationError("RESOURCE_SIZE_EXCEEDED", "The resource exceeds the byte limit.");
			}
			chunks.push(value);
		}
	} catch {
		return verificationError("FETCH_FAILED", "The resource response could not be read.");
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return { success: true, value: output };
}

async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<VerificationResult<ReadableStreamReadResult<Uint8Array>>> {
	try {
		return {
			success: true,
			value: await withTimeout(
				Promise.resolve().then(() => reader.read()),
				timeoutMs,
			),
		};
	} catch (error) {
		if (isAbortError(error))
			return verificationError(
				"RESOURCE_TIMEOUT",
				"The resource fetch exceeded its total timeout.",
			);
		return verificationError("FETCH_FAILED", "The resource response could not be read.");
	}
}

/**
 * Every operation has both fulfillment and rejection handlers, so an operation
 * that loses the timeout race cannot later become an unhandled rejection.
 */
function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			onTimeout?.();
			reject(new DOMException("Timed out", "AbortError"));
		}, timeoutMs);
		void operation.then(
			(value) => {
				if (settled) return undefined;
				settled = true;
				clearTimeout(timeout);
				resolve(value);
				return undefined;
			},
			(error: unknown) => {
				if (settled) return undefined;
				settled = true;
				clearTimeout(timeout);
				reject(error);
				return undefined;
			},
		);
	});
}

function areValidLimits(limits: Record<string, number>): boolean {
	return Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0);
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function isIpLiteral(hostname: string): boolean {
	return IPV4_LITERAL.test(hostname) || hostname.includes(":");
}

function isLocalHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal")
	);
}

function isForbiddenAddress(address: string): boolean {
	const ipv4 = parseIpv4(address);
	if (ipv4 !== null) {
		const [a, b] = ipv4;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 0 || b === 168)) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	const ipv6 = parseIpv6(address);
	if (ipv6 === null) return true;
	const first = ipv6[0]!;
	const isUnspecified = ipv6.every((part) => part === 0);
	const isLoopback = ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1;
	const isPrivate = (first & 0xfe00) === 0xfc00;
	const isLinkLocal = (first & 0xffc0) === 0xfe80;
	const isMulticast = (first & 0xff00) === 0xff00;
	const mappedIpv4 = ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff;
	if (mappedIpv4) {
		return isForbiddenAddress(
			`${ipv6[6]! >>> 8}.${ipv6[6]! & 0xff}.${ipv6[7]! >>> 8}.${ipv6[7]! & 0xff}`,
		);
	}
	return isUnspecified || isLoopback || isPrivate || isLinkLocal || isMulticast;
}

function parseIpv4(value: string): [number, number, number, number] | null {
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	const numbers = parts.map((part) => (IPV4_PART.test(part) ? Number(part) : Number.NaN));
	if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!];
}

function parseIpv6(value: string): number[] | null {
	if (value.includes(":::") || value.split("::").length > 2) return null;
	const [before = "", after = ""] = value.split("::");
	const head = before === "" ? [] : before.split(":");
	const tail = after === "" ? [] : after.split(":");
	const parts = [...head, ...tail];
	if (parts.some((part) => !IPV6_PART.test(part)) || parts.length > 8) return null;
	if (!value.includes("::") && parts.length !== 8) return null;
	const zeroes = value.includes("::") ? 8 - parts.length : 0;
	return [...head, ...Array.from<string>({ length: zeroes }).fill("0"), ...tail].map((part) =>
		Number.parseInt(part, 16),
	);
}
