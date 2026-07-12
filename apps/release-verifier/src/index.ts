import {
	fetchVerifiedResource,
	type FetchImplementation,
	type HostnameResolver,
	type VerificationResult,
} from "@emdash-cms/registry-verification/fetch";
import { WorkerEntrypoint } from "cloudflare:workers";

export const ARTIFACT_MAX_BYTES = 384 * 1024;
export const PROVENANCE_MAX_BYTES = 1024 * 1024;

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TIMEOUT_MS = 5_000;
const DNS_MAX_BYTES = 64 * 1024;
const FETCH_HEADER_TIMEOUT_MS = 10_000;
const FETCH_TOTAL_TIMEOUT_MS = 30_000;
const FETCH_MAX_REDIRECTS = 3;
const DIGITS = /^\d+$/;

interface DnsAnswer {
	type: number;
	data: string;
}

interface DnsResponse {
	Status: number;
	Answer?: DnsAnswer[];
}

export interface FetchDependencies {
	fetch: FetchImplementation;
	resolveHostname: HostnameResolver;
	headerTimeoutMs?: number;
	totalTimeoutMs?: number;
}

export default class ReleaseVerifier extends WorkerEntrypoint {
	fetchArtifact(url: string): Promise<VerificationResult<Uint8Array>> {
		return fetchResource(url, ARTIFACT_MAX_BYTES);
	}

	fetchProvenance(url: string): Promise<VerificationResult<Uint8Array>> {
		return fetchResource(url, PROVENANCE_MAX_BYTES);
	}
}

export async function fetchResource(
	url: string,
	maxBytes: number,
	dependencies: FetchDependencies = {
		fetch: globalThis.fetch,
		resolveHostname,
	},
): Promise<VerificationResult<Uint8Array>> {
	const result = await fetchVerifiedResource(url, {
		fetch: dependencies.fetch,
		resolveHostname: dependencies.resolveHostname,
		headerTimeoutMs: dependencies.headerTimeoutMs ?? FETCH_HEADER_TIMEOUT_MS,
		totalTimeoutMs: dependencies.totalTimeoutMs ?? FETCH_TOTAL_TIMEOUT_MS,
		maxBytes,
		maxRedirects: FETCH_MAX_REDIRECTS,
	});
	return result.success ? { success: true, value: result.value.bytes } : result;
}

export async function resolveHostname(hostname: string): Promise<readonly string[]> {
	const responses = await Promise.all([queryDns(hostname, "A", 1), queryDns(hostname, "AAAA", 28)]);
	return responses.flat();
}

async function queryDns(hostname: string, queryType: "A" | "AAAA", answerType: number) {
	const url = new URL(DNS_ENDPOINT);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", queryType);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: { accept: "application/dns-json" },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error("DNS query failed");
		const body = await readBoundedBody(response, DNS_MAX_BYTES);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
		if (!isDnsResponse(parsed) || parsed.Status !== 0) throw new Error("Invalid DNS response");
		return (parsed.Answer ?? [])
			.filter((answer) => answer.type === answerType)
			.map((answer) => answer.data);
	} finally {
		clearTimeout(timeout);
	}
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null && (!DIGITS.test(contentLength) || Number(contentLength) > maxBytes)) {
		throw new Error("DNS response exceeds limit");
	}
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.length;
			if (length > maxBytes) {
				await reader.cancel();
				throw new Error("DNS response exceeds limit");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

function isDnsResponse(value: unknown): value is DnsResponse {
	if (!isRecord(value) || !Number.isInteger(value["Status"])) return false;
	const answers = value["Answer"];
	return (
		answers === undefined ||
		(Array.isArray(answers) &&
			answers.every(
				(answer) =>
					isRecord(answer) &&
					Number.isInteger(answer["type"]) &&
					typeof answer["data"] === "string",
			))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
