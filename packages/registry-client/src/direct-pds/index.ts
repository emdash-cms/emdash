// eslint-disable-next-line @typescript-eslint/no-empty-named-blocks, eslint-plugin-import/no-empty-named-blocks, eslint-plugin-unicorn/require-module-specifiers, import/no-empty-named-blocks, unicorn/require-module-specifiers
import type {} from "@atcute/atproto";
import { encode } from "@atcute/cbor";
import * as CID from "@atcute/cid";
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import { parseCanonicalResourceUri } from "@atcute/lexicons";
import { safeParse } from "@atcute/lexicons/validations";
import { NSID, PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";
import compare from "semver/functions/compare.js";
import valid from "semver/functions/valid.js";

import type { Did } from "../credentials/types.js";

export const DEFAULT_DIRECT_PDS_MAX_RECORDS = 1_000;
export const DEFAULT_DIRECT_PDS_PAGE_SIZE = 100;
export const DEFAULT_DIRECT_PDS_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_DIRECT_PDS_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DIGITS_RE = /^\d+$/;
const MAX_TIMEOUT_MS = 2_147_483_647;

export type DirectPdsReadErrorCode =
	| "ENUMERATION_CURSOR_REPEATED"
	| "ENUMERATION_TRUNCATED"
	| "PDS_REQUEST_ABORTED"
	| "PDS_REQUEST_FAILED"
	| "PDS_REQUEST_TIMEOUT"
	| "PDS_RESPONSE_TOO_LARGE"
	| "PROFILE_IDENTITY_MISMATCH"
	| "PROFILE_LEXICON_INVALID"
	| "RECORD_CID_INVALID"
	| "RECORD_CID_MISMATCH"
	| "RECORD_CID_MISSING"
	| "RELEASE_ENUMERATION_AMBIGUOUS"
	| "RELEASE_IDENTITY_MISMATCH"
	| "RELEASE_LEXICON_INVALID"
	| "RELEASE_VERSION_INVALID";

export class DirectPdsReadError extends Error {
	readonly code: DirectPdsReadErrorCode;

	constructor(code: DirectPdsReadErrorCode, message: string) {
		super(message);
		this.name = "DirectPdsReadError";
		this.code = code;
	}
}

export interface DirectPdsClientOptions {
	did: Did;
	pds: string;
	fetch?: typeof fetch;
	requestTimeoutMs?: number;
	maxResponseBytes?: number;
	signal?: AbortSignal;
}

export interface DirectPdsProfileRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: PackageProfile.Main;
}

export interface DirectPdsReleaseRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: PackageRelease.Main;
}

export interface DirectPdsEnumerationOptions {
	maxRecords?: number;
	pageSize?: number;
}

/** Unauthenticated reads against one explicitly configured publisher PDS. */
export class DirectPdsClient {
	readonly did: Did;
	readonly pds: string;
	readonly #client: Client;

	constructor(options: DirectPdsClientOptions) {
		validatePdsOrigin(options.pds);
		const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_DIRECT_PDS_REQUEST_TIMEOUT_MS;
		const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_DIRECT_PDS_MAX_RESPONSE_BYTES;
		validatePositiveSafeInteger(requestTimeoutMs, "requestTimeoutMs");
		if (requestTimeoutMs > MAX_TIMEOUT_MS) {
			throw new RangeError(`requestTimeoutMs must not exceed ${MAX_TIMEOUT_MS}`);
		}
		validatePositiveSafeInteger(maxResponseBytes, "maxResponseBytes");
		this.did = options.did;
		this.pds = options.pds;
		this.#client = new Client({
			handler: simpleFetchHandler({
				service: options.pds,
				fetch: createBoundedFetch(options.fetch ?? globalThis.fetch, {
					requestTimeoutMs,
					maxResponseBytes,
					signal: options.signal,
				}),
			}),
		});
	}

	async getPackageProfile(packageSlug: string): Promise<DirectPdsProfileRecord> {
		validatePackageSlug(packageSlug);
		const data = await ok(
			this.#client.get("com.atproto.repo.getRecord", {
				params: { repo: this.did, collection: NSID.packageProfile, rkey: packageSlug },
			}),
		);
		const identity = parseIdentity(data.uri, this.did, NSID.packageProfile);
		if (!identity || identity.rkey !== packageSlug) {
			throw new DirectPdsReadError(
				"PROFILE_IDENTITY_MISMATCH",
				"The PDS returned a profile with a different record identity.",
			);
		}
		const parsed = safeParse(PackageProfile.mainSchema, data.value);
		if (!parsed.ok) {
			throw new DirectPdsReadError(
				"PROFILE_LEXICON_INVALID",
				"The PDS returned a malformed package profile.",
			);
		}
		if (parsed.value.id !== data.uri || (parsed.value.slug && parsed.value.slug !== packageSlug)) {
			throw new DirectPdsReadError(
				"PROFILE_IDENTITY_MISMATCH",
				"The signed profile does not match its authoritative record identity.",
			);
		}
		const cid = await verifyRecordCid(data.cid, parsed.value);
		return { uri: data.uri, cid, rkey: identity.rkey, value: parsed.value };
	}

	async getPackageRelease(packageSlug: string, version: string): Promise<DirectPdsReleaseRecord> {
		validatePackageSlug(packageSlug);
		const rkey = `${packageSlug}:${version}`;
		const data = await ok(
			this.#client.get("com.atproto.repo.getRecord", {
				params: { repo: this.did, collection: NSID.packageRelease, rkey },
			}),
		);
		return await validateReleaseRecord(data, this.did, packageSlug, rkey);
	}

	async listPackageReleases(
		packageSlug: string,
		options: DirectPdsEnumerationOptions = {},
	): Promise<DirectPdsReleaseRecord[]> {
		validatePackageSlug(packageSlug);
		const maxRecords = options.maxRecords ?? DEFAULT_DIRECT_PDS_MAX_RECORDS;
		const pageSize = options.pageSize ?? DEFAULT_DIRECT_PDS_PAGE_SIZE;
		if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
			throw new RangeError("maxRecords must be a positive safe integer");
		}
		if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
			throw new RangeError("pageSize must be an integer from 1 to 100");
		}

		const releases: DirectPdsReleaseRecord[] = [];
		const seenCursors = new Set<string>();
		const seenRkeys = new Set<string>();
		let enumerated = 0;
		let cursor: string | undefined;

		while (true) {
			const data = await ok(
				this.#client.get("com.atproto.repo.listRecords", {
					params: {
						repo: this.did,
						collection: NSID.packageRelease,
						limit: Math.min(pageSize, maxRecords - enumerated),
						...(cursor ? { cursor } : {}),
					},
				}),
			);
			enumerated += data.records.length;
			if (enumerated > maxRecords) {
				throw new DirectPdsReadError(
					"ENUMERATION_TRUNCATED",
					"The PDS returned more records than the configured bound.",
				);
			}

			for (const record of data.records) {
				const identity = parseIdentity(record.uri, this.did, NSID.packageRelease);
				if (!identity) {
					throw new DirectPdsReadError(
						"RELEASE_ENUMERATION_AMBIGUOUS",
						"The PDS returned a release with a non-authoritative identity.",
					);
				}
				if (!identity.rkey.startsWith(`${packageSlug}:`)) continue;
				if (seenRkeys.has(identity.rkey)) {
					throw new DirectPdsReadError(
						"RELEASE_ENUMERATION_AMBIGUOUS",
						"The PDS returned a duplicate release record key.",
					);
				}
				seenRkeys.add(identity.rkey);
				releases.push(await validateReleaseRecord(record, this.did, packageSlug, identity.rkey));
			}

			if (!data.cursor) return releases;
			if (data.records.length === 0 || enumerated >= maxRecords) {
				throw new DirectPdsReadError(
					"ENUMERATION_TRUNCATED",
					"Release enumeration exceeded its configured bound.",
				);
			}
			if (seenCursors.has(data.cursor)) {
				throw new DirectPdsReadError(
					"ENUMERATION_CURSOR_REPEATED",
					"The PDS repeated an enumeration cursor.",
				);
			}
			seenCursors.add(data.cursor);
			cursor = data.cursor;
		}
	}
}

/** Select the highest-semver current release, excluding the proposed record key. */
export function selectSemverBaseline(
	releases: readonly DirectPdsReleaseRecord[],
	options: { excludeRkey: string },
): DirectPdsReleaseRecord | null {
	const separator = options.excludeRkey.indexOf(":");
	const packageSlug = options.excludeRkey.slice(0, separator);
	if (separator < 1 || !PACKAGE_SLUG_RE.test(packageSlug)) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The proposed release key has no canonical package identity.",
		);
	}
	let baseline: DirectPdsReleaseRecord | null = null;
	const versions = new Set<string>();
	for (const release of releases) {
		if (release.rkey === options.excludeRkey) continue;
		const version = release.value.version;
		if (release.value.package !== packageSlug || release.rkey !== `${packageSlug}:${version}`) {
			throw new DirectPdsReadError(
				"RELEASE_IDENTITY_MISMATCH",
				"A baseline release belongs to a different package identity.",
			);
		}
		if (!isCanonicalVersion(version)) {
			throw new DirectPdsReadError(
				"RELEASE_VERSION_INVALID",
				"A release cannot participate in semver baseline selection.",
			);
		}
		if (versions.has(version)) {
			throw new DirectPdsReadError(
				"RELEASE_ENUMERATION_AMBIGUOUS",
				"Multiple releases have the same semantic version.",
			);
		}
		versions.add(version);
		if (!baseline || compare(version, baseline.value.version) > 0) baseline = release;
	}
	return baseline;
}

async function validateReleaseRecord(
	record: { uri: string; cid?: string; value: unknown },
	did: string,
	packageSlug: string,
	expectedRkey: string,
): Promise<DirectPdsReleaseRecord> {
	const identity = parseIdentity(record.uri, did, NSID.packageRelease);
	if (!identity || identity.rkey !== expectedRkey) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The PDS returned a release with a different record identity.",
		);
	}
	const parsed = safeParse(PackageRelease.mainSchema, record.value);
	if (!parsed.ok) {
		throw new DirectPdsReadError(
			"RELEASE_LEXICON_INVALID",
			"The PDS returned a malformed package release.",
		);
	}
	if (
		parsed.value.package !== packageSlug ||
		!isCanonicalVersion(parsed.value.version) ||
		expectedRkey !== `${packageSlug}:${parsed.value.version}`
	) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The signed release does not match its package, version, and record key.",
		);
	}
	const cid = await verifyRecordCid(record.cid, parsed.value);
	return { uri: record.uri, cid, rkey: identity.rkey, value: parsed.value };
}

function parseIdentity(uri: string, did: string, collection: string): { rkey: string } | null {
	try {
		const parsed = parseCanonicalResourceUri(uri);
		return parsed.repo === did && parsed.collection === collection && parsed.rkey
			? { rkey: parsed.rkey }
			: null;
	} catch {
		return null;
	}
}

function isCanonicalVersion(version: string): boolean {
	return !version.includes("+") && valid(version) === version;
}

const PACKAGE_SLUG_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function validatePackageSlug(value: string): void {
	if (!PACKAGE_SLUG_RE.test(value)) {
		throw new DirectPdsReadError(
			"RELEASE_IDENTITY_MISMATCH",
			"The package slug is not valid for an authoritative release identity.",
		);
	}
}

function validatePdsOrigin(value: string): void {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new TypeError("pds must be an HTTPS origin");
	}
}

async function verifyRecordCid(cid: string | undefined, value: unknown): Promise<string> {
	if (!cid) throw missingCid();
	let claimed: CID.Cid;
	try {
		claimed = CID.fromString(cid);
		if (claimed.codec !== CID.CODEC_DCBOR || CID.toString(claimed) !== cid) throw new Error();
	} catch {
		throw new DirectPdsReadError("RECORD_CID_INVALID", "The PDS returned an invalid record CID.");
	}
	let computed: CID.Cid;
	try {
		computed = await CID.create(CID.CODEC_DCBOR, encode(value));
	} catch {
		throw new DirectPdsReadError(
			"RECORD_CID_MISMATCH",
			"The PDS record value does not match its claimed CID.",
		);
	}
	if (!CID.equals(claimed, computed)) {
		throw new DirectPdsReadError(
			"RECORD_CID_MISMATCH",
			"The PDS record value does not match its claimed CID.",
		);
	}
	return cid;
}

interface BoundedFetchOptions {
	requestTimeoutMs: number;
	maxResponseBytes: number;
	signal?: AbortSignal;
}

function createBoundedFetch(fetchImplementation: typeof fetch, options: BoundedFetchOptions) {
	return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const controller = new AbortController();
		let timedOut = false;
		const cleanupSignals = forwardAbortSignals(
			[options.signal, init.signal].filter((signal): signal is AbortSignal => signal !== undefined),
			controller,
		);
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, options.requestTimeoutMs);

		try {
			if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
			const response = await withAbortSignal(
				Promise.resolve().then(() =>
					fetchImplementation(input, { ...init, signal: controller.signal }),
				),
				controller.signal,
			);
			const contentLength = response.headers.get("content-length");
			if (contentLength !== null) {
				const declaredLength = Number(contentLength);
				if (
					!DIGITS_RE.test(contentLength) ||
					!Number.isSafeInteger(declaredLength) ||
					declaredLength > options.maxResponseBytes
				) {
					void response.body?.cancel().catch(() => undefined);
					throw responseTooLarge();
				}
			}
			const body = await readBoundedBody(
				response.body,
				options.maxResponseBytes,
				controller.signal,
			);
			return new Response(body.length === 0 ? null : body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			if (error instanceof DirectPdsReadError) throw error;
			if (timedOut) {
				throw new DirectPdsReadError("PDS_REQUEST_TIMEOUT", "The direct PDS request timed out.");
			}
			if (controller.signal.aborted) {
				throw new DirectPdsReadError("PDS_REQUEST_ABORTED", "The direct PDS request was aborted.");
			}
			throw new DirectPdsReadError("PDS_REQUEST_FAILED", "The direct PDS request failed.");
		} finally {
			clearTimeout(timeout);
			cleanupSignals();
		}
	};
}

async function readBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (body === null) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let completed = false;
	try {
		for (;;) {
			const chunk = await withAbortSignal(reader.read(), signal);
			if (chunk.done) {
				completed = true;
				break;
			}
			length += chunk.value.length;
			if (length > maximumBytes) throw responseTooLarge();
			chunks.push(chunk.value);
		}
	} finally {
		if (!completed) void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new DOMException("Aborted", "AbortError"));
		if (signal.aborted) {
			abort();
		} else {
			signal.addEventListener("abort", abort, { once: true });
		}
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
				return undefined;
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
				return undefined;
			},
		);
	});
}

function forwardAbortSignals(signals: AbortSignal[], controller: AbortController): () => void {
	const abort = () => controller.abort();
	for (const signal of signals) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	return () => {
		for (const signal of signals) signal.removeEventListener("abort", abort);
	};
}

function validatePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

function responseTooLarge(): DirectPdsReadError {
	return new DirectPdsReadError(
		"PDS_RESPONSE_TOO_LARGE",
		"The direct PDS response exceeded its byte limit.",
	);
}

function missingCid(): DirectPdsReadError {
	return new DirectPdsReadError(
		"RECORD_CID_MISSING",
		"The PDS response omitted the authoritative record CID.",
	);
}
