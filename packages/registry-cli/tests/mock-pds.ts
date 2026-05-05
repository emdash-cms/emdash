/**
 * Mock atproto PDS for tests.
 *
 * Implements just enough of `com.atproto.repo.{getRecord,putRecord,listRecords}`
 * to drive `PublishingClient`-shaped tests without booting a real PDS or
 * going through OAuth.
 *
 * State is held in-memory keyed by AT URI (`at://<did>/<collection>/<rkey>`).
 * Test helpers expose the underlying record map so individual tests can seed
 * existing records, assert what was written, or verify call counts.
 *
 * Returns realistic atproto error payloads (`RecordNotFound`,
 * `InvalidRequest`) so the publish flow's error handling — which keys off
 * `ClientResponseError.error === "RecordNotFound"` — runs the same paths a
 * real PDS would trigger.
 */

import type { FetchHandlerObject } from "@atcute/client";

interface StoredRecord {
	uri: string;
	cid: string;
	value: unknown;
}

interface MockPdsCall {
	method: string;
	pathname: string;
	body?: unknown;
}

export interface MockPdsOptions {
	/**
	 * The DID this mock pretends to host. Defaults to a fixed test DID; tests
	 * that need a different one can override.
	 */
	did?: `did:${string}:${string}`;
}

/**
 * In-memory mock PDS implementing the `FetchHandlerObject` contract that
 * `PublishingClient.fromHandler` accepts.
 */
export class MockPds implements FetchHandlerObject {
	readonly did: `did:${string}:${string}`;
	readonly records = new Map<string, StoredRecord>();
	readonly calls: MockPdsCall[] = [];
	#cidCounter = 0;

	constructor(options: MockPdsOptions = {}) {
		this.did = options.did ?? "did:plc:test123";
	}

	async handle(pathname: string, init: RequestInit): Promise<Response> {
		const url = new URL(pathname, "http://mock.test");
		const method = init.method?.toLowerCase() ?? "get";

		const body = await readJsonBody(init.body);
		this.calls.push({ method, pathname, ...(body !== undefined ? { body } : {}) });

		switch (url.pathname) {
			case "/xrpc/com.atproto.repo.getRecord":
				return this.#getRecord(url);
			case "/xrpc/com.atproto.repo.putRecord":
				return this.#putRecord(body);
			case "/xrpc/com.atproto.repo.listRecords":
				return this.#listRecords(url);
			default:
				return jsonResponse(404, {
					error: "MethodNotFound",
					message: `mock-pds does not implement ${url.pathname}`,
				});
		}
	}

	/** Pre-seed a record under this DID. Helper for tests. */
	seedRecord(collection: string, rkey: string, value: unknown): StoredRecord {
		const uri = `at://${this.did}/${collection}/${rkey}`;
		const stored: StoredRecord = {
			uri,
			cid: this.#mintCid(),
			value,
		};
		this.records.set(uri, stored);
		return stored;
	}

	/**
	 * Returns calls matching the given XRPC method name, in order. Useful for
	 * asserting that the publish flow made the expected XRPC sequence.
	 */
	callsTo(nsid: string): MockPdsCall[] {
		return this.calls.filter((c) => c.pathname.startsWith(`/xrpc/${nsid}`));
	}

	#getRecord(url: URL): Response {
		const repo = url.searchParams.get("repo") ?? this.did;
		const collection = url.searchParams.get("collection");
		const rkey = url.searchParams.get("rkey");
		if (!collection || !rkey) {
			return jsonResponse(400, {
				error: "InvalidRequest",
				message: "missing collection or rkey",
			});
		}
		const uri = `at://${repo}/${collection}/${rkey}`;
		const record = this.records.get(uri);
		if (!record) {
			return jsonResponse(400, {
				error: "RecordNotFound",
				message: `Could not locate record: ${uri}`,
			});
		}
		return jsonResponse(200, {
			uri: record.uri,
			cid: record.cid,
			value: record.value,
		});
	}

	#putRecord(body: unknown): Response {
		if (!body || typeof body !== "object") {
			return jsonResponse(400, { error: "InvalidRequest", message: "missing body" });
		}
		const input = body as {
			repo: string;
			collection: string;
			rkey: string;
			record: unknown;
		};
		const uri = `at://${input.repo}/${input.collection}/${input.rkey}`;
		const stored: StoredRecord = {
			uri,
			cid: this.#mintCid(),
			value: input.record,
		};
		this.records.set(uri, stored);
		return jsonResponse(200, { uri: stored.uri, cid: stored.cid });
	}

	#listRecords(url: URL): Response {
		const repo = url.searchParams.get("repo") ?? this.did;
		const collection = url.searchParams.get("collection");
		if (!collection) {
			return jsonResponse(400, {
				error: "InvalidRequest",
				message: "missing collection",
			});
		}
		const prefix = `at://${repo}/${collection}/`;
		const records = [...this.records.values()].filter((r) => r.uri.startsWith(prefix));
		return jsonResponse(200, { records });
	}

	#mintCid(): string {
		this.#cidCounter += 1;
		// Format-shaped string that satisfies CID validators (`b...` base32);
		// content doesn't have to round-trip a real CID for our tests.
		return `bafyreigh${"a".repeat(40)}${this.#cidCounter}`;
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function readJsonBody(body: BodyInit | null | undefined): Promise<unknown> {
	if (body === null || body === undefined) return undefined;
	if (typeof body === "string") {
		try {
			return JSON.parse(body) as unknown;
		} catch {
			return body;
		}
	}
	if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
		const text = new TextDecoder().decode(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text;
		}
	}
	// Streams, FormData, Blob, etc. -- not used in our tests.
	return undefined;
}
