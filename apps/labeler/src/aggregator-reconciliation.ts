import type { DeclaredAccess } from "@emdash-cms/plugin-types";

import type { AssessmentSubject } from "./assessment/types.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface AggregatorReconciliationClient {
	listCurrentSubjects(
		cursor?: string,
		limit?: number,
	): Promise<{
		items: readonly AssessmentSubject[];
		nextCursor?: string;
	}>;
	isCurrentSubject(uri: string, cid: string): Promise<boolean>;
}

export function createAggregatorReconciliationClient(
	service: Fetcher,
	token: string,
): AggregatorReconciliationClient {
	const request = createAuthenticatedRequest(service, token);
	return {
		async listCurrentSubjects(cursor, limit = 100) {
			const url = new URL("https://aggregator.internal/_internal/labeler/subjects");
			if (cursor) url.searchParams.set("cursor", cursor);
			url.searchParams.set("limit", String(limit));
			const value = await request(url);
			if (!isRecord(value) || !Array.isArray(value["items"])) {
				throw new Error("aggregator reconciliation response is invalid");
			}
			const items = value["items"].map(parseSubject);
			const nextCursor = value["nextCursor"];
			if (nextCursor !== undefined && typeof nextCursor !== "string") {
				throw new Error("aggregator reconciliation cursor is invalid");
			}
			return { items, ...(nextCursor ? { nextCursor } : {}) };
		},
		async isCurrentSubject(uri, cid) {
			const url = new URL("https://aggregator.internal/_internal/labeler/current");
			url.searchParams.set("uri", uri);
			url.searchParams.set("cid", cid);
			const value = await request(url);
			if (!isRecord(value) || typeof value["current"] !== "boolean") {
				throw new Error("aggregator current-subject response is invalid");
			}
			return value["current"];
		},
	};
}

export interface AggregatorPreviousReleaseLookup {
	previousRelease(uri: string): Promise<{ version: string; declaredAccess: DeclaredAccess } | null>;
}

export function createAggregatorPreviousReleaseLookup(
	service: Fetcher,
	token: string,
): AggregatorPreviousReleaseLookup {
	const request = createAuthenticatedRequest(service, token);
	return {
		async previousRelease(uri) {
			const url = new URL("https://aggregator.internal/_internal/labeler/previous-release");
			url.searchParams.set("uri", uri);
			const value = await request(url);
			if (!isRecord(value) || value["found"] !== true) {
				throw new Error("aggregator has not indexed the release being assessed");
			}
			const previous = value["previous"];
			if (previous === null) return null;
			if (
				!isRecord(previous) ||
				typeof previous["version"] !== "string" ||
				!isRecord(previous["declaredAccess"])
			) {
				throw new Error("aggregator previous-release response is invalid");
			}
			return {
				version: previous["version"],
				declaredAccess: previous["declaredAccess"],
			};
		},
	};
}

function createAuthenticatedRequest(service: Fetcher, token: string) {
	if (!token) throw new TypeError("aggregator reconciliation token is not configured");
	return async (url: URL): Promise<unknown> => {
		const response = await service.fetch(
			new Request(url, { headers: { authorization: `Bearer ${token}` } }),
		);
		if (!response.ok)
			throw new Error(`aggregator reconciliation request failed: ${response.status}`);
		const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES);
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	};
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("aggregator reconciliation response body is missing");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maximumBytes) throw new RangeError("aggregator response exceeds its byte limit");
			chunks.push(next.value);
		}
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

function parseSubject(value: unknown): AssessmentSubject {
	if (
		!isRecord(value) ||
		typeof value["uri"] !== "string" ||
		typeof value["cid"] !== "string" ||
		(value["kind"] !== "profile" && value["kind"] !== "release")
	) {
		throw new Error("aggregator reconciliation subject is invalid");
	}
	return { uri: value["uri"], cid: value["cid"], kind: value["kind"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
