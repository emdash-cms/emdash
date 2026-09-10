import type { CanonicalMediaDescriptor } from "@emdash-cms/registry-moderation";
import { verifyMultihash } from "@emdash-cms/registry-verification/checksum";

import type { AssessmentSubject } from "./types.js";

const IPV4_LITERAL_RE = /^\d+(?:\.\d+){3}$/;
const IPV6_CHARACTER_RE = /^[0-9a-f:]+$/;
const IPV6_LINK_LOCAL_RE = /^fe[89ab]/;

export const DEFAULT_MEDIA_LIMITS = Object.freeze({
	maxBytes: 8 * 1024 * 1024,
	maxRedirects: 3,
	timeoutMs: 15_000,
	maxDimension: 8192,
	maxPixels: 32 * 1024 * 1024,
	maxFrames: 16,
	maxDecodedBytes: 64 * 1024 * 1024,
});

export const DEFAULT_MEDIA_SET_LIMITS = Object.freeze({
	maxConcurrency: 2,
	maxAggregateBytes: 24 * 1024 * 1024,
	maxAggregatePixels: 64 * 1024 * 1024,
	maxAggregateFrames: 80,
	maxDecodeOperations: 10,
});

export interface MediaAcquisitionLimits {
	maxBytes: number;
	maxRedirects: number;
	timeoutMs: number;
	maxDimension: number;
	maxPixels: number;
	maxFrames: number;
	maxDecodedBytes: number;
}

export interface MediaSetLimits {
	maxConcurrency: number;
	maxAggregateBytes: number;
	maxAggregatePixels: number;
	maxAggregateFrames: number;
	maxDecodeOperations: number;
}

export interface MediaHostnameResolver {
	resolve(
		hostname: string,
		options: { signal: AbortSignal; deadline: number },
	): Promise<readonly string[]>;
}

export interface GuardedMediaTransport {
	fetch(input: {
		url: string;
		allowedAddresses: readonly string[];
		headers: Readonly<Record<string, string>>;
		redirect: "manual";
		signal: AbortSignal;
		deadline: number;
	}): Promise<{ response: Response; connectedAddress: string }>;
}

export interface PinnedMediaFetchImplementation {
	fetch(input: {
		url: string;
		allowedAddresses: readonly string[];
		init: RequestInit & { redirect: "manual" };
		deadline: number;
	}): Promise<{ response: Response; connectedAddress: string }>;
}

export interface MediaContentStore {
	put(input: {
		idempotencyKey: string;
		contentAddress: string;
		subject: AssessmentSubject;
		descriptor: CanonicalMediaDescriptor;
		bytes: Uint8Array;
		sha256: string;
		mimeType: string;
		width: number;
		height: number;
		frames: number;
		signal: AbortSignal;
		deadline: number;
	}): Promise<{ contentRef: string; contentAddress: string }>;
}

export interface DisplayMediaDecoder {
	decode(
		bytes: Uint8Array,
		limits: {
			signal: AbortSignal;
			deadline: number;
			maxPixels: number;
			maxFrames: number;
			maxDecodedBytes: number;
		},
	): Promise<{
		mimeType: string;
		width: number;
		height: number;
		frames: number;
	}>;
}

export interface MediaBudgetReservation {
	readonly maxBytes: number;
	commit(input: { bytes: number; pixels: number; frames: number }): void;
	release(): void;
}

export interface MediaAggregateBudget {
	reserve(maxBytes: number): MediaBudgetReservation;
}

export interface MediaAcquisitionContext {
	budget?: MediaAggregateBudget;
	neverFetchUrls?: ReadonlySet<string>;
}

export interface DisplayMediaAcquirer {
	acquire(
		subject: AssessmentSubject,
		descriptor: CanonicalMediaDescriptor,
		context?: MediaAcquisitionContext,
	): Promise<VerifiedDisplayMedia>;
}

export interface VerifiedDisplayMedia {
	kind: CanonicalMediaDescriptor["kind"];
	index: number;
	sha256: string;
	mimeType: string;
	byteLength: number;
	width: number;
	height: number;
	frames: number;
	contentAddress: string;
	contentRef: string;
}

export interface GuardedMediaAcquirerOptions {
	resolver: MediaHostnameResolver;
	transport: GuardedMediaTransport;
	store: MediaContentStore;
	decoder: DisplayMediaDecoder;
	limits?: Partial<MediaAcquisitionLimits>;
	now?: () => number;
}

export class MediaTransportConfigurationError extends Error {
	override readonly name = "MediaTransportConfigurationError";
}

export function createPinnedMediaTransport(
	implementation: PinnedMediaFetchImplementation,
): GuardedMediaTransport {
	return {
		async fetch(input) {
			const result = await implementation.fetch({
				url: input.url,
				allowedAddresses: input.allowedAddresses,
				init: {
					headers: input.headers,
					redirect: "manual",
					signal: input.signal,
				},
				deadline: input.deadline,
			});
			if (!input.allowedAddresses.includes(result.connectedAddress)) {
				await cancelResponseBody(result.response);
				throw new Error("display media connection was not pinned to an approved address");
			}
			return result;
		},
	};
}

export function createFailClosedNativeFetchMediaTransport(): GuardedMediaTransport {
	return {
		async fetch() {
			throw new MediaTransportConfigurationError(
				"native Worker fetch cannot prove DNS pinning; configure a pinned media transport",
			);
		},
	};
}

export function createGuardedMediaAcquirer(
	options: GuardedMediaAcquirerOptions,
): DisplayMediaAcquirer {
	const limits = { ...DEFAULT_MEDIA_LIMITS, ...options.limits };
	const now = options.now ?? Date.now;
	assertLimits(limits);
	return {
		async acquire(subject, descriptor, context): Promise<VerifiedDisplayMedia> {
			assertDisplayMediaDescriptor(descriptor);
			if (descriptor.requiresAuth) {
				throw new Error("display media requiring authentication cannot be assessed");
			}
			const reservation = context?.budget?.reserve(limits.maxBytes);
			const maximumBytes = reservation?.maxBytes ?? limits.maxBytes;
			const controller = new AbortController();
			const deadline = now() + limits.timeoutMs;
			const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
			let committed = false;
			try {
				const neverFetchUrls = new Set(
					Array.from(context?.neverFetchUrls ?? [], normalizeComparableUrl),
				);
				const response = await fetchFollowingSafeRedirects(
					descriptor,
					options.resolver,
					options.transport,
					limits.maxRedirects,
					controller.signal,
					deadline,
					neverFetchUrls,
				);
				const bytes = await readBoundedBody(response, maximumBytes, controller.signal);
				assertBeforeDeadline(controller.signal, deadline, now);
				const checksum = await verifyMultihash(bytes, descriptor.checksum);
				if (!checksum.success) {
					throw new Error(`display media checksum rejected: ${checksum.error.code}`);
				}
				const sniffed = inspectImage(bytes, limits.maxDimension);
				const image = await abortable(
					options.decoder.decode(bytes, {
						signal: controller.signal,
						deadline,
						maxPixels: limits.maxPixels,
						maxFrames: limits.maxFrames,
						maxDecodedBytes: limits.maxDecodedBytes,
					}),
					controller.signal,
				);
				assertBeforeDeadline(controller.signal, deadline, now);
				validateDecodedImage(image, sniffed, descriptor, limits);
				const pixels = image.width * image.height * image.frames;
				reservation?.commit({ bytes: bytes.byteLength, pixels, frames: image.frames });
				committed = true;
				const sha256 = toHex(
					new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
				);
				const contentAddress = `sha256:${sha256}`;
				const idempotencyKey = await createMediaStoreIdempotencyKey(
					subject,
					descriptor,
					contentAddress,
				);
				const stored = await abortable(
					options.store.put({
						idempotencyKey,
						contentAddress,
						subject,
						descriptor,
						bytes,
						sha256,
						mimeType: image.mimeType,
						width: image.width,
						height: image.height,
						frames: image.frames,
						signal: controller.signal,
						deadline,
					}),
					controller.signal,
				);
				assertBeforeDeadline(controller.signal, deadline, now);
				if (
					stored.contentRef.length === 0 ||
					stored.contentRef.length > 512 ||
					stored.contentAddress !== contentAddress
				) {
					throw new Error("display media store returned an invalid content reference");
				}
				return {
					kind: descriptor.kind,
					index: descriptor.index,
					sha256,
					mimeType: image.mimeType,
					byteLength: bytes.byteLength,
					width: image.width,
					height: image.height,
					frames: image.frames,
					contentAddress,
					contentRef: stored.contentRef,
				};
			} finally {
				clearTimeout(timeout);
				if (!committed) reservation?.release();
			}
		},
	};
}

export async function acquireDisplayMediaSet(
	subject: AssessmentSubject,
	descriptors: readonly CanonicalMediaDescriptor[],
	acquirer: DisplayMediaAcquirer,
	limitsOverride: Partial<MediaSetLimits> = {},
	neverFetchUrls: readonly string[] = [],
): Promise<VerifiedDisplayMedia[]> {
	const limits = { ...DEFAULT_MEDIA_SET_LIMITS, ...limitsOverride };
	assertSetLimits(limits);
	if (descriptors.length > limits.maxDecodeOperations) {
		throw new RangeError("display media set exceeds the decode-operation budget");
	}
	const budget = createMediaAggregateBudget(limits);
	const forbidden = new Set(neverFetchUrls.map(normalizeComparableUrl));
	const results: Array<VerifiedDisplayMedia | undefined> = Array.from({
		length: descriptors.length,
	});
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < descriptors.length) {
			const index = nextIndex;
			nextIndex += 1;
			const descriptor = descriptors[index];
			if (!descriptor) throw new Error("display media descriptor disappeared");
			results[index] = await acquirer.acquire(subject, descriptor, {
				budget,
				neverFetchUrls: forbidden,
			});
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limits.maxConcurrency, descriptors.length) }, () => worker()),
	);
	return results.map((result) => {
		if (!result) throw new Error("display media acquisition did not produce every result");
		return result;
	});
}

function createMediaAggregateBudget(limits: MediaSetLimits): MediaAggregateBudget {
	let reservedBytes = 0;
	let consumedBytes = 0;
	let consumedPixels = 0;
	let consumedFrames = 0;
	return {
		reserve(maxBytes) {
			const available = limits.maxAggregateBytes - consumedBytes - reservedBytes;
			if (available <= 0) throw new RangeError("display media set exhausted its byte budget");
			const reserved = Math.min(maxBytes, available);
			reservedBytes += reserved;
			let settled = false;
			return {
				maxBytes: reserved,
				commit(input) {
					if (settled) throw new Error("display media budget reservation is already settled");
					settled = true;
					reservedBytes -= reserved;
					if (
						input.bytes > reserved ||
						consumedBytes + input.bytes > limits.maxAggregateBytes ||
						consumedPixels + input.pixels > limits.maxAggregatePixels ||
						consumedFrames + input.frames > limits.maxAggregateFrames
					) {
						throw new RangeError("display media set exceeds its aggregate budget");
					}
					consumedBytes += input.bytes;
					consumedPixels += input.pixels;
					consumedFrames += input.frames;
				},
				release() {
					if (settled) return;
					settled = true;
					reservedBytes -= reserved;
				},
			};
		},
	};
}

async function fetchFollowingSafeRedirects(
	descriptor: CanonicalMediaDescriptor,
	resolver: MediaHostnameResolver,
	transport: GuardedMediaTransport,
	maxRedirects: number,
	signal: AbortSignal,
	deadline: number,
	neverFetchUrls: ReadonlySet<string>,
): Promise<Response> {
	let url = descriptor.url;
	for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
		if (signal.aborted) throw new Error("display media acquisition deadline exceeded");
		const parsed = validateMediaUrl(url);
		if (neverFetchUrls.has(normalizeComparableUrl(parsed))) {
			throw new Error("display media target aliases a never-fetch resource");
		}
		const addresses = await abortable(
			resolver.resolve(parsed.hostname, { signal, deadline }),
			signal,
		);
		if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
			throw new Error("display media host did not resolve exclusively to public addresses");
		}
		const { response } = await abortable(
			transport.fetch({
				url: parsed.toString(),
				allowedAddresses: addresses,
				headers: {
					accept: descriptor.releaseAsset ? "application/octet-stream" : "image/*",
				},
				redirect: "manual",
				signal,
				deadline,
			}),
			signal,
		);
		if (response.status < 300 || response.status > 399) {
			if (!response.ok) {
				await cancelResponseBody(response);
				throw new Error(`display media request failed with status ${response.status}`);
			}
			return response;
		}
		const location = response.headers.get("location");
		await cancelResponseBody(response);
		if (redirect === maxRedirects) throw new Error("display media exceeded redirect limit");
		if (!location) throw new Error("display media redirect omitted its location");
		url = new URL(location, parsed).toString();
	}
	throw new Error("display media redirect processing did not terminate");
}

function normalizeComparableUrl(value: string | URL): string {
	const url = value instanceof URL ? new URL(value) : new URL(value);
	url.hash = "";
	return url.toString();
}

function validateMediaUrl(value: string): URL {
	if (containsControlCharacter(value)) {
		throw new TypeError("display media URL contains control characters");
	}
	const parsed = new URL(value);
	if (parsed.protocol !== "https:") throw new TypeError("display media URL must use HTTPS");
	if (parsed.port !== "") throw new TypeError("display media URL must use HTTPS port 443");
	if (parsed.username !== "" || parsed.password !== "") {
		throw new TypeError("display media URL must not contain credentials");
	}
	if (isIpLiteral(parsed.hostname)) {
		throw new TypeError("display media URL must not use an IP literal");
	}
	return parsed;
}

function isIpLiteral(hostname: string): boolean {
	return hostname.startsWith("[") || IPV4_LITERAL_RE.test(hostname);
}

export function isPublicAddress(address: string): boolean {
	const ipv4 = parseIpv4(address);
	if (ipv4) {
		const [a, b] = ipv4;
		if (a === undefined) return false;
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b !== undefined && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
			(a === 192 && (b === 0 || b === 168)) ||
			(a === 198 && b !== undefined && (b === 18 || b === 19))
		);
	}
	const normalized = address.toLowerCase();
	if (!IPV6_CHARACTER_RE.test(normalized) || !normalized.includes(":")) return false;
	if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
	if (normalized === "::" || normalized === "::1") return false;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
	if (IPV6_LINK_LOCAL_RE.test(normalized) || normalized.startsWith("ff")) return false;
	if (normalized.startsWith("2001:db8:")) return false;
	return normalized.startsWith("2") || normalized.startsWith("3");
}

function parseIpv4(address: string): number[] | null {
	if (!IPV4_LITERAL_RE.test(address)) return null;
	const octets = address.split(".").map(Number);
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
	return octets;
}

async function readBoundedBody(
	response: Response,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		await cancelResponseBody(response);
		throw new Error("display media exceeds the byte limit");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("display media response body is missing");
	const chunks: Uint8Array[] = [];
	let total = 0;
	let done = false;
	try {
		while (!done) {
			if (signal.aborted) throw new Error("display media acquisition deadline exceeded");
			const next = await abortable(reader.read(), signal);
			done = next.done;
			if (next.value) {
				total += next.value.byteLength;
				if (total > maximumBytes) throw new Error("display media exceeds the byte limit");
				chunks.push(next.value);
			}
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function inspectImage(
	bytes: Uint8Array,
	maximumDimension: number,
): { mimeType: string; width: number; height: number } {
	const image = inspectPng(bytes) ?? inspectGif(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
	if (!image) throw new Error("display media bytes are not a supported image");
	if (
		image.width < 1 ||
		image.height < 1 ||
		image.width > maximumDimension ||
		image.height > maximumDimension
	) {
		throw new Error("display media dimensions are outside the allowed range");
	}
	return image;
}

function validateDecodedImage(
	image: { mimeType: string; width: number; height: number; frames: number },
	sniffed: { mimeType: string; width: number; height: number },
	descriptor: CanonicalMediaDescriptor,
	limits: MediaAcquisitionLimits,
): void {
	if (
		normalizeMimeType(image.mimeType) !== sniffed.mimeType ||
		image.width !== sniffed.width ||
		image.height !== sniffed.height
	) {
		throw new Error("display media decoder result does not match the file header");
	}
	const pixels = image.width * image.height * image.frames;
	if (
		!Number.isInteger(image.frames) ||
		image.frames < 1 ||
		image.frames > limits.maxFrames ||
		pixels > limits.maxPixels ||
		pixels * 4 > limits.maxDecodedBytes
	) {
		throw new Error("display media decode exceeds its resource budget");
	}
	if (descriptor.contentType && normalizeMimeType(descriptor.contentType) !== image.mimeType) {
		throw new Error("display media content type does not match its bytes");
	}
	if (descriptor.width !== undefined && descriptor.width !== image.width) {
		throw new Error("display media width does not match its descriptor");
	}
	if (descriptor.height !== undefined && descriptor.height !== image.height) {
		throw new Error("display media height does not match its descriptor");
	}
}

function inspectPng(bytes: Uint8Array) {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
	return { mimeType: "image/png", width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) };
}

function inspectGif(bytes: Uint8Array) {
	if (bytes.length < 10) return null;
	const header = new TextDecoder().decode(bytes.slice(0, 6));
	if (header !== "GIF87a" && header !== "GIF89a") return null;
	return { mimeType: "image/gif", width: readUint16Le(bytes, 6), height: readUint16Le(bytes, 8) };
}

function inspectJpeg(bytes: Uint8Array) {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 8 < bytes.length) {
		if (bytes[offset] !== 0xff) return null;
		const marker = bytes[offset + 1];
		if (marker === undefined) return null;
		if (marker === 0xd9 || marker === 0xda) break;
		const length = readUint16Be(bytes, offset + 2);
		if (length < 2 || offset + 2 + length > bytes.length) return null;
		if (
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf)
		) {
			return {
				mimeType: "image/jpeg",
				width: readUint16Be(bytes, offset + 7),
				height: readUint16Be(bytes, offset + 5),
			};
		}
		offset += 2 + length;
	}
	return null;
}

function inspectWebp(bytes: Uint8Array) {
	if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
		return null;
	}
	const kind = ascii(bytes, 12, 4);
	if (kind === "VP8X") {
		return {
			mimeType: "image/webp",
			width: readUint24Le(bytes, 24) + 1,
			height: readUint24Le(bytes, 27) + 1,
		};
	}
	if (kind === "VP8L" && bytes[20] === 0x2f) {
		const bits = readUint32Le(bytes, 21);
		return {
			mimeType: "image/webp",
			width: (bits & 0x3fff) + 1,
			height: ((bits >>> 14) & 0x3fff) + 1,
		};
	}
	if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
		return {
			mimeType: "image/webp",
			width: readUint16Le(bytes, 26) & 0x3fff,
			height: readUint16Le(bytes, 28) & 0x3fff,
		};
	}
	return null;
}

async function createMediaStoreIdempotencyKey(
	subject: AssessmentSubject,
	descriptor: CanonicalMediaDescriptor,
	contentAddress: string,
): Promise<string> {
	const encoded = JSON.stringify([
		1,
		subject.uri,
		subject.cid,
		descriptor.kind,
		descriptor.index,
		descriptor.checksum,
		contentAddress,
	]);
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)),
	);
	return `media-v1-${toHex(digest)}`;
}

async function cancelResponseBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("display media acquisition deadline exceeded");
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("display media acquisition deadline exceeded"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function assertBeforeDeadline(signal: AbortSignal, deadline: number, now: () => number): void {
	if (signal.aborted || now() >= deadline) {
		throw new Error("display media acquisition deadline exceeded");
	}
}

function normalizeMimeType(value: string): string {
	return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return new TextDecoder().decode(bytes.slice(offset, offset + length));
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function assertDisplayMediaDescriptor(descriptor: CanonicalMediaDescriptor): void {
	if (!(["icon", "banner", "screenshot"] as const).includes(descriptor.kind)) {
		throw new TypeError("only display media may be acquired");
	}
	if (!Number.isInteger(descriptor.index) || descriptor.index < 0) {
		throw new TypeError("display media index is invalid");
	}
}

function assertLimits(limits: MediaAcquisitionLimits): void {
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isInteger(value) || value < (key === "maxRedirects" ? 0 : 1)) {
			throw new TypeError("display media limits are invalid");
		}
	}
}

function assertSetLimits(limits: MediaSetLimits): void {
	for (const value of Object.values(limits)) {
		if (!Number.isInteger(value) || value < 1) {
			throw new TypeError("display media set limits are invalid");
		}
	}
}
