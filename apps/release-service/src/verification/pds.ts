import type { ActorResolver } from "@atcute/identity-resolver";
import { isDid } from "@atcute/lexicons/syntax";
import { NSID } from "@emdash-cms/registry-lexicons";
import { fetchVerifiedResource } from "@emdash-cms/registry-verification";
import compareVersions from "semver/functions/compare.js";
import validVersion from "semver/functions/valid.js";

import { createWorkerActorResolver } from "../oauth/custody.js";

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DNS_BYTES = 64 * 1024;
const MAX_PDS_RESPONSE_BYTES = 512 * 1024;
const MAX_RELEASE_PAGES = 100;
const PAGE_LIMIT = 100;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;

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
	fetch?: typeof globalThis.fetch;
}

export class PublisherSnapshotError extends Error {
	readonly code:
		| "PUBLISHER_IDENTITY_INVALID"
		| "PUBLISHER_PDS_INVALID"
		| "PROFILE_INVALID"
		| "RELEASE_EXISTS"
		| "RELEASE_LIST_INVALID";

	constructor(code: PublisherSnapshotError["code"]) {
		super(code);
		this.name = "PublisherSnapshotError";
		this.code = code;
	}
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

async function resolvePublicHostname(
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

function guardedIdentityFetch(fetchImplementation: typeof fetch): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (method !== "GET") throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
		const value = await guardedJson(url, fetchImplementation);
		return Response.json(value);
	};
}

async function getProfile(
	pds: string,
	publisherDid: string,
	packageSlug: string,
	fetchImplementation: typeof fetch,
): Promise<AuthoritativeRecord> {
	const url = pdsXrpcUrl(pds, "com.atproto.repo.getRecord");
	url.searchParams.set("repo", publisherDid);
	url.searchParams.set("collection", NSID.packageProfile);
	url.searchParams.set("rkey", packageSlug);
	const record = parseRecord(await guardedJson(url, fetchImplementation));
	const expectedUri = `at://${publisherDid}/${NSID.packageProfile}/${packageSlug}`;
	if (!record || record.uri !== expectedUri) throw new PublisherSnapshotError("PROFILE_INVALID");
	return record;
}

async function listPackageReleases(
	pds: string,
	publisherDid: string,
	packageSlug: string,
	fetchImplementation: typeof fetch,
): Promise<readonly AuthoritativeRecord[]> {
	const records: AuthoritativeRecord[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	for (let page = 0; page < MAX_RELEASE_PAGES; page += 1) {
		const url = pdsXrpcUrl(pds, "com.atproto.repo.listRecords");
		url.searchParams.set("repo", publisherDid);
		url.searchParams.set("collection", NSID.packageRelease);
		url.searchParams.set("limit", String(PAGE_LIMIT));
		url.searchParams.set("rkeyStart", `${packageSlug}:`);
		url.searchParams.set("rkeyEnd", `${packageSlug}:~`);
		if (cursor !== null) url.searchParams.set("cursor", cursor);
		const parsed = await guardedJson(url, fetchImplementation);
		if (!isRecord(parsed) || !Array.isArray(parsed["records"])) {
			throw new PublisherSnapshotError("RELEASE_LIST_INVALID");
		}
		for (const value of parsed["records"]) {
			const record = parseRecord(value);
			if (!record) throw new PublisherSnapshotError("RELEASE_LIST_INVALID");
			records.push(record);
		}
		if (parsed["cursor"] === undefined) return records;
		if (
			typeof parsed["cursor"] !== "string" ||
			parsed["cursor"].length < 1 ||
			parsed["cursor"].length > 4096 ||
			cursors.has(parsed["cursor"])
		) {
			throw new PublisherSnapshotError("RELEASE_LIST_INVALID");
		}
		cursor = parsed["cursor"];
		cursors.add(cursor);
	}
	throw new PublisherSnapshotError("RELEASE_LIST_INVALID");
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
	let actor;
	try {
		actor = await (
			options.actorResolver ?? createWorkerActorResolver(guardedIdentityFetch(fetchImplementation))
		).resolve(publisherDid, { signal: AbortSignal.timeout(30_000), noCache: true });
	} catch {
		throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	}
	if (actor.did !== publisherDid) throw new PublisherSnapshotError("PUBLISHER_IDENTITY_INVALID");
	const [profile, releases] = await Promise.all([
		getProfile(actor.pds, publisherDid, packageSlug, fetchImplementation),
		listPackageReleases(actor.pds, publisherDid, packageSlug, fetchImplementation),
	]);
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
