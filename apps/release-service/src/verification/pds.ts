import type { ActorResolver } from "@atcute/identity-resolver";
import { isDid } from "@atcute/lexicons/syntax";
import {
	DEFAULT_DIRECT_PDS_MAX_RESPONSE_BYTES,
	DirectPdsClient,
	DirectPdsReadError,
	type DirectPdsDidDocumentResolver,
} from "@emdash-cms/registry-client/direct-pds";
import { NSID } from "@emdash-cms/registry-lexicons";
import { fetchVerifiedResource } from "@emdash-cms/registry-verification/fetch";
import compareVersions from "semver/functions/compare.js";
import validVersion from "semver/functions/valid.js";

import { createWorkerActorResolver } from "../oauth/custody.js";

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DNS_BYTES = 64 * 1024;
const MAX_PDS_RESPONSE_BYTES = 512 * 1024;
const MAX_REPO_EXPORT_RESPONSE_BYTES = DEFAULT_DIRECT_PDS_MAX_RESPONSE_BYTES;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const UPSTREAM_STATUS_HEADER = "x-emdash-upstream-status";

export interface AuthoritativeRecord {
	uri: string;
	cid: string;
	value: unknown;
}

export interface PublisherVerificationSnapshot {
	profile: AuthoritativeRecord;
	proposedRkey: string;
	proposedReleaseAbsent: boolean;
	baseline: AuthoritativeRecord | null;
	baselineVersion: string | null;
}

export interface ReadPublisherSnapshotOptions {
	actorResolver?: ActorResolver;
	didDocumentResolver?: DirectPdsDidDocumentResolver;
	fetch?: typeof globalThis.fetch;
}

export class PublisherSnapshotError extends Error {
	readonly code:
		| "PUBLISHER_IDENTITY_INVALID"
		| "PUBLISHER_PDS_INVALID"
		| "PROFILE_INVALID"
		| "RELEASE_EXISTS"
		| "RELEASE_RECORD_INVALID"
		| "RELEASE_LIST_INVALID";

	constructor(code: PublisherSnapshotError["code"]) {
		super(code);
		this.name = "PublisherSnapshotError";
		this.code = code;
	}
}

const PUBLISHER_SNAPSHOT_ERROR_CODES: readonly PublisherSnapshotError["code"][] = [
	"PUBLISHER_IDENTITY_INVALID",
	"PUBLISHER_PDS_INVALID",
	"PROFILE_INVALID",
	"RELEASE_EXISTS",
	"RELEASE_RECORD_INVALID",
	"RELEASE_LIST_INVALID",
];

export function publisherSnapshotErrorCode(error: unknown): PublisherSnapshotError["code"] | null {
	if (error instanceof PublisherSnapshotError) return error.code;
	if (!(error instanceof Error)) return null;
	return (
		PUBLISHER_SNAPSHOT_ERROR_CODES.find(
			(code) => error.message === `PublisherSnapshotError: ${code}`,
		) ?? null
	);
}

export function samePdsOrigin(left: string, right: string): boolean {
	return new URL(left).origin === new URL(right).origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
	if (!response.ok || !response.body) throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
}

async function resolveDnsType(
	hostname: string,
	type: "A" | "AAAA",
	fetchImplementation: typeof fetch,
): Promise<readonly string[]> {
	const url = new URL(DNS_ENDPOINT);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const parsed = await readBoundedJson(
		await fetchImplementation(url, {
			headers: { accept: "application/dns-json" },
			redirect: "error",
			signal: AbortSignal.timeout(5_000),
		}),
		MAX_DNS_BYTES,
	);
	if (!isRecord(parsed) || parsed["Status"] !== 0 || !Array.isArray(parsed["Answer"])) {
		return [];
	}
	const expectedType = type === "A" ? 1 : 28;
	return parsed["Answer"].flatMap((answer): string[] => {
		if (
			!isRecord(answer) ||
			answer["type"] !== expectedType ||
			typeof answer["data"] !== "string"
		) {
			return [];
		}
		return [answer["data"]];
	});
}

export async function resolvePublicHostname(
	hostname: string,
	fetchImplementation: typeof fetch,
): Promise<readonly string[]> {
	if (hostname.length === 0 || hostname.length > 253) return [];
	const [ipv4, ipv6] = await Promise.all([
		resolveDnsType(hostname, "A", fetchImplementation),
		resolveDnsType(hostname, "AAAA", fetchImplementation),
	]);
	return [...ipv4, ...ipv6];
}

async function guardedJson(url: URL, fetchImplementation: typeof fetch): Promise<unknown> {
	const resource = await fetchVerifiedResource(url, {
		fetch: (input, init) => fetchImplementation(input, init),
		resolveHostname: (hostname) => resolvePublicHostname(hostname, fetchImplementation),
		headerTimeoutMs: 10_000,
		totalTimeoutMs: 30_000,
		maxBytes: MAX_PDS_RESPONSE_BYTES,
		maxRedirects: 1,
	});
	if (!resource.success || resource.value.url.toString() !== url.toString()) {
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(resource.value.bytes),
		);
	} catch {
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
}

function guardedFetch(
	fetchImplementation: typeof fetch,
	maximumBytes = MAX_PDS_RESPONSE_BYTES,
): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (method.toUpperCase() !== "GET") {
			throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
		}
		const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
		const resource = await fetchVerifiedResource(url, {
			fetch: async (verifiedUrl, verifiedInit) => {
				const response = await fetchImplementation(verifiedUrl, {
					...verifiedInit,
					...(headers === undefined ? {} : { headers }),
				});
				const responseHeaders = new Headers(response.headers);
				responseHeaders.set(UPSTREAM_STATUS_HEADER, String(response.status));
				return new Response(response.body, {
					status: response.status === 404 ? 200 : response.status,
					statusText: response.status === 404 ? "OK" : response.statusText,
					headers: responseHeaders,
				});
			},
			resolveHostname: (hostname) => resolvePublicHostname(hostname, fetchImplementation),
			headerTimeoutMs: 10_000,
			totalTimeoutMs: 30_000,
			maxBytes: maximumBytes,
			maxRedirects: 1,
		});
		if (!resource.success || resource.value.url.toString() !== url.toString()) {
			throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
		}
		const upstreamStatus = Number(resource.value.headers.get(UPSTREAM_STATUS_HEADER));
		if (!Number.isSafeInteger(upstreamStatus)) {
			throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
		}
		return new Response(resource.value.bytes, {
			status: upstreamStatus,
			headers: resource.value.headers,
		});
	};
}

async function guardedRecordJson(
	url: URL,
	fetchImplementation: typeof fetch,
): Promise<{ status: number; value: unknown }> {
	const resource = await fetchVerifiedResource(url, {
		fetch: async (input, init) => {
			const response = await fetchImplementation(input, init);
			const headers = new Headers(response.headers);
			headers.set(UPSTREAM_STATUS_HEADER, String(response.status));
			return new Response(response.body, {
				status: response.status === 400 ? 200 : response.status,
				statusText: response.status === 400 ? "OK" : response.statusText,
				headers,
			});
		},
		resolveHostname: (hostname) => resolvePublicHostname(hostname, fetchImplementation),
		headerTimeoutMs: 10_000,
		totalTimeoutMs: 30_000,
		maxBytes: MAX_PDS_RESPONSE_BYTES,
		maxRedirects: 1,
	});
	if (!resource.success || resource.value.url.toString() !== url.toString()) {
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
	const status = Number(resource.value.headers.get(UPSTREAM_STATUS_HEADER));
	if (!Number.isSafeInteger(status)) throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	try {
		return {
			status,
			value: JSON.parse(
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(resource.value.bytes),
			),
		};
	} catch {
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
}

function pdsXrpcUrl(pds: string, method: string): URL {
	let url: URL;
	try {
		url = new URL(pds);
	} catch {
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
	url.pathname = `/xrpc/${method}`;
	return url;
}

function parseRecord(value: unknown): AuthoritativeRecord | null {
	if (
		!isRecord(value) ||
		typeof value["uri"] !== "string" ||
		value["uri"].length > 4096 ||
		typeof value["cid"] !== "string" ||
		value["cid"].length > 256 ||
		!("value" in value)
	) {
		return null;
	}
	return { uri: value["uri"], cid: value["cid"], value: value["value"] };
}

export async function resolvePublisherPds(
	publisherDid: string,
	options: ReadPublisherSnapshotOptions = {},
): Promise<string> {
	if (!isDid(publisherDid)) throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	let actor;
	try {
		actor = await (
			options.actorResolver ?? createWorkerActorResolver(guardedIdentityFetch(fetchImplementation))
		).resolve(publisherDid, { signal: AbortSignal.timeout(30_000), noCache: true });
	} catch {
		throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	}
	if (actor.did !== publisherDid) throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	return actor.pds;
}

function guardedIdentityFetch(fetchImplementation: typeof fetch): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (method !== "GET") throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
		const value = await guardedJson(url, fetchImplementation);
		return Response.json(value);
	};
}

async function getPackageRepository(
	publisherDid: string,
	packageSlug: string,
	fetchImplementation: typeof fetch,
	didDocumentResolver?: DirectPdsDidDocumentResolver,
): Promise<{
	profile: AuthoritativeRecord;
	releases: readonly AuthoritativeRecord[];
}> {
	try {
		const repository = await new DirectPdsClient({
			did: publisherDid,
			fetch: guardedFetch(fetchImplementation, MAX_REPO_EXPORT_RESPONSE_BYTES),
			...(didDocumentResolver === undefined ? {} : { didDocumentResolver }),
			requestTimeoutMs: 30_000,
			maxResponseBytes: MAX_REPO_EXPORT_RESPONSE_BYTES,
		}).getPackageRepository(packageSlug);
		return {
			profile: {
				uri: repository.profile.uri,
				cid: repository.profile.cid,
				value: repository.profile.value,
			},
			releases: repository.releases.map((record) => ({
				uri: record.uri,
				cid: record.cid,
				value: record.value,
			})),
		};
	} catch (error) {
		if (error instanceof DirectPdsReadError) {
			if (
				error.code === "DID_DOCUMENT_INVALID" ||
				error.code === "DID_RESOLUTION_FAILED" ||
				error.code === "DID_SIGNING_KEY_INVALID" ||
				error.code === "DID_SIGNING_KEY_MISSING" ||
				error.code === "PDS_ENDPOINT_INVALID" ||
				error.code === "PDS_ENDPOINT_MISSING" ||
				error.code === "REPOSITORY_NOT_FOUND"
			) {
				throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
			}
			if (error.code === "PROFILE_LEXICON_INVALID" || error.code === "RECORD_NOT_FOUND") {
				throw new PublisherSnapshotError("PROFILE_INVALID");
			}
			if (error.code === "RELEASE_LEXICON_INVALID" || error.code === "RECORD_PROOF_INVALID") {
				throw new PublisherSnapshotError("RELEASE_LIST_INVALID");
			}
		}
		if (error instanceof TypeError) {
			throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
		}
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
}

async function getRelease(
	pds: string,
	publisherDid: string,
	packageSlug: string,
	version: string,
	fetchImplementation: typeof fetch,
): Promise<AuthoritativeRecord | null> {
	const rkey = `${packageSlug}:${version}`;
	const url = pdsXrpcUrl(pds, "com.atproto.repo.getRecord");
	url.searchParams.set("repo", publisherDid);
	url.searchParams.set("collection", NSID.packageRelease);
	url.searchParams.set("rkey", rkey);
	const response = await guardedRecordJson(url, fetchImplementation);
	if (
		response.status === 400 &&
		isRecord(response.value) &&
		response.value["error"] === "RecordNotFound"
	) {
		return null;
	}
	if (response.status !== 200) throw new PublisherSnapshotError("RELEASE_RECORD_INVALID");
	const record = parseRecord(response.value);
	const expectedUri = `at://${publisherDid}/${NSID.packageRelease}/${rkey}`;
	if (!record || record.uri !== expectedUri) {
		throw new PublisherSnapshotError("RELEASE_RECORD_INVALID");
	}
	return record;
}

function releaseVersion(record: AuthoritativeRecord, publisherDid: string, packageSlug: string) {
	const prefix = `at://${publisherDid}/${NSID.packageRelease}/${packageSlug}:`;
	if (!record.uri.startsWith(prefix)) throw new PublisherSnapshotError("RELEASE_LIST_INVALID");
	const version = record.uri.slice(prefix.length);
	if (!VERSION_PATTERN.test(version) || validVersion(version) !== version) {
		throw new PublisherSnapshotError("RELEASE_LIST_INVALID");
	}
	return version;
}

export async function readPublisherVerificationSnapshot(
	publisherDid: string,
	packageSlug: string,
	version: string,
	options: ReadPublisherSnapshotOptions = {},
): Promise<PublisherVerificationSnapshot> {
	if (
		!isDid(publisherDid) ||
		!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
		!VERSION_PATTERN.test(version)
	) {
		throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	}
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const { profile, releases } = await getPackageRepository(
		publisherDid,
		packageSlug,
		fetchImplementation,
		options.didDocumentResolver,
	);
	const proposedRkey = `${packageSlug}:${version}`;
	let baseline: AuthoritativeRecord | null = null;
	let baselineVersion: string | null = null;
	for (const release of releases) {
		const candidate = releaseVersion(release, publisherDid, packageSlug);
		if (candidate === version) throw new PublisherSnapshotError("RELEASE_EXISTS");
		if (baselineVersion === null || compareVersions(candidate, baselineVersion) > 0) {
			baseline = release;
			baselineVersion = candidate;
		}
	}
	return {
		profile,
		proposedRkey,
		proposedReleaseAbsent: true,
		baseline,
		baselineVersion,
	};
}

export async function findAuthoritativeRelease(
	publisherDid: string,
	packageSlug: string,
	version: string,
	options: ReadPublisherSnapshotOptions = {},
): Promise<AuthoritativeRecord | null> {
	if (
		!isDid(publisherDid) ||
		!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
		!VERSION_PATTERN.test(version)
	) {
		throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	}
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const pds = await resolvePublisherPds(publisherDid, options);
	return getRelease(pds, publisherDid, packageSlug, version, fetchImplementation);
}

export async function findProofVerifiedRelease(
	publisherDid: string,
	packageSlug: string,
	version: string,
	options: ReadPublisherSnapshotOptions = {},
): Promise<AuthoritativeRecord | null> {
	if (
		!isDid(publisherDid) ||
		!PACKAGE_SLUG_PATTERN.test(packageSlug) ||
		!VERSION_PATTERN.test(version)
	) {
		throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	}
	const advertised = await findAuthoritativeRelease(publisherDid, packageSlug, version, options);
	if (!advertised) return null;
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	try {
		const record = await new DirectPdsClient({
			did: publisherDid,
			fetch: guardedFetch(fetchImplementation),
			...(options.didDocumentResolver === undefined
				? {}
				: { didDocumentResolver: options.didDocumentResolver }),
			requestTimeoutMs: 30_000,
			maxResponseBytes: MAX_PDS_RESPONSE_BYTES,
		}).getPackageRelease(packageSlug, version);
		return { uri: record.uri, cid: record.cid, value: record.value };
	} catch (error) {
		if (error instanceof DirectPdsReadError) {
			if (error.code === "RECORD_NOT_FOUND") return null;
			if (
				error.code === "DID_DOCUMENT_INVALID" ||
				error.code === "DID_RESOLUTION_FAILED" ||
				error.code === "DID_SIGNING_KEY_INVALID" ||
				error.code === "DID_SIGNING_KEY_MISSING" ||
				error.code === "PDS_ENDPOINT_INVALID" ||
				error.code === "PDS_ENDPOINT_MISSING"
			) {
				throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
			}
			if (error.code === "RELEASE_LEXICON_INVALID" || error.code === "RECORD_PROOF_INVALID") {
				throw new PublisherSnapshotError("RELEASE_RECORD_INVALID");
			}
		}
		if (error instanceof TypeError) {
			throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
		}
		throw new PublisherSnapshotError("PUBLISHER_PDS_INVALID");
	}
}
