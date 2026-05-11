/**
 * Mock atproto PDS for tests.
 *
 * Implements just enough of `com.atproto.repo.{getRecord,putRecord,listRecords,applyWrites}`
 * to drive `PublishingClient`-shaped tests without booting a real PDS or
 * going through OAuth.
 *
 * State is held in-memory keyed by AT URI (`at://<did>/<collection>/<rkey>`).
 * Test helpers expose the underlying record map so individual tests can seed
 * existing records, assert what was written, or verify call counts.
 *
 * Returns realistic atproto error payloads (`RecordNotFound`,
 * `InvalidRequest`, `RepoMismatch`) so the publish flow's error handling --
 * which keys off `ClientResponseError.error === "RecordNotFound"` -- runs
 * the same paths a real PDS would trigger.
 *
 * What this mock does NOT model:
 *
 *   - Atproto MST signing or repo commit chain.
 *   - DPoP or OAuth token validation.
 *   - Lexicon-level record validation. (We don't run `mainSchema.safeParse`
 *     against `validate: true` requests; tests that need that should hit a
 *     real PDS.)
 *
 * What it DOES enforce:
 *
 *   - The `repo` field on every write must match the mock's DID. A real PDS
 *     ties auth to repo; ours has no auth, so we cross-check that callers
 *     are writing where they think they are.
 *   - rkey must match atproto's record-key alphabet (`[a-zA-Z0-9_~.:-]+`).
 *     Used to verify that the registry CLI never sends rkeys that a real
 *     PDS would reject.
 *   - CIDs are derived from the record bytes so an overwrite with identical
 *     bytes returns an identical CID (matching real PDS behaviour). Tests
 *     that want to detect "did this actually rewrite the record?" should
 *     compare bytes, not CIDs.
 */

import { createHash } from "node:crypto";

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

const RKEY_RE = /^[a-zA-Z0-9._~:-]+$/;

/**
 * In-memory mock PDS implementing the `FetchHandlerObject` contract that
 * `PublishingClient.fromHandler` accepts.
 */
export class MockPds implements FetchHandlerObject {
	readonly did: `did:${string}:${string}`;
	readonly records = new Map<string, StoredRecord>();
	readonly calls: MockPdsCall[] = [];

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
			case "/xrpc/com.atproto.repo.applyWrites":
				return this.#applyWrites(body);
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
			cid: cidOf(value),
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
		if (repo !== this.did) {
			return jsonResponse(400, {
				error: "RepoNotFound",
				message: `mock-pds hosts ${this.did}, not ${repo}`,
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
		const guard = this.#validateWriteTarget(input.repo, input.collection, input.rkey);
		if (guard) return guard;
		const uri = `at://${input.repo}/${input.collection}/${input.rkey}`;
		const stored: StoredRecord = {
			uri,
			cid: cidOf(input.record),
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
		if (repo !== this.did) {
			return jsonResponse(400, {
				error: "RepoNotFound",
				message: `mock-pds hosts ${this.did}, not ${repo}`,
			});
		}
		const prefix = `at://${repo}/${collection}/`;
		const records = [...this.records.values()].filter((r) => r.uri.startsWith(prefix));
		return jsonResponse(200, { records });
	}

	#applyWrites(body: unknown): Response {
		if (!body || typeof body !== "object") {
			return jsonResponse(400, { error: "InvalidRequest", message: "missing body" });
		}
		const input = body as {
			repo: string;
			writes: Array<{
				$type: string;
				collection: string;
				rkey?: string;
				value?: unknown;
			}>;
		};
		if (input.repo !== this.did) {
			return jsonResponse(400, {
				error: "RepoNotFound",
				message: `mock-pds hosts ${this.did}, not ${input.repo}`,
			});
		}

		// Validate every operation up front; either all-or-nothing, like a real
		// applyWrites would be (atomic commit). Validation includes:
		//   - rkey present
		//   - rkey shape and repo match
		//   - create ops must not collide with an existing record
		//   - update ops must target an existing record
		//
		// CAVEAT: this mock evaluates create/update existence against the
		// pre-batch state. Whether a real PDS allows within-batch
		// dependencies (e.g. `create A; update A` in one applyWrites) is
		// not crisply documented in the atproto spec, and behaviour may
		// vary between PDS implementations. The publish flow doesn't
		// depend on within-batch dependencies (profile and release have
		// different rkeys), so the divergence (if any) doesn't affect
		// coverage today. If you change the publish flow to issue a
		// dependent batch, validate the assumption against an actual PDS
		// before relying on it.
		for (const op of input.writes ?? []) {
			if (!op.rkey) {
				return jsonResponse(400, {
					error: "InvalidRequest",
					message: `applyWrites op missing rkey: ${JSON.stringify(op)}`,
				});
			}
			const guard = this.#validateWriteTarget(input.repo, op.collection, op.rkey);
			if (guard) return guard;
			const uri = `at://${input.repo}/${op.collection}/${op.rkey}`;
			if (op.$type === "com.atproto.repo.applyWrites#create" && this.records.has(uri)) {
				return jsonResponse(400, {
					error: "RecordAlreadyExists",
					message: `cannot create ${uri}: a record with that key already exists`,
				});
			}
			if (op.$type === "com.atproto.repo.applyWrites#update" && !this.records.has(uri)) {
				return jsonResponse(400, {
					error: "RecordNotFound",
					message: `cannot update ${uri}: no record with that key exists`,
				});
			}
		}

		// Apply atomically: collect results, then commit.
		const results: Array<Record<string, unknown>> = [];
		for (const op of input.writes ?? []) {
			const uri = `at://${input.repo}/${op.collection}/${op.rkey}`;
			switch (op.$type) {
				case "com.atproto.repo.applyWrites#create":
				case "com.atproto.repo.applyWrites#update": {
					const stored: StoredRecord = {
						uri,
						cid: cidOf(op.value),
						value: op.value,
					};
					this.records.set(uri, stored);
					const resultType =
						op.$type === "com.atproto.repo.applyWrites#create"
							? "com.atproto.repo.applyWrites#createResult"
							: "com.atproto.repo.applyWrites#updateResult";
					results.push({
						$type: resultType,
						uri: stored.uri,
						cid: stored.cid,
					});
					break;
				}
				case "com.atproto.repo.applyWrites#delete":
					this.records.delete(uri);
					results.push({ $type: "com.atproto.repo.applyWrites#deleteResult" });
					break;
				default:
					return jsonResponse(400, {
						error: "InvalidRequest",
						message: `unknown applyWrites op $type: ${op.$type}`,
					});
			}
		}
		return jsonResponse(200, { results });
	}

	/**
	 * Cross-check that every write targets this mock's repo and that the rkey
	 * matches atproto's record-key alphabet. Real PDSes enforce both; without
	 * these guards a test could write malformed records that a real PDS would
	 * have rejected.
	 */
	#validateWriteTarget(repo: string, collection: string, rkey: string): Response | null {
		if (repo !== this.did) {
			return jsonResponse(400, {
				error: "RepoNotFound",
				message: `mock-pds hosts ${this.did}, not ${repo}`,
			});
		}
		if (!collection) {
			return jsonResponse(400, {
				error: "InvalidRequest",
				message: "missing collection",
			});
		}
		if (!RKEY_RE.test(rkey) || rkey.length === 0 || rkey.length > 512) {
			return jsonResponse(400, {
				error: "InvalidRequest",
				message: `rkey ${JSON.stringify(rkey)} is not a valid record key`,
			});
		}
		return null;
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Mock CID derivation: sha256 of the JSON-stringified value, prefixed with `b`
 * (base32 multibase) and shaped to look like a CIDv1. Crucially, identical
 * record values produce identical CIDs -- matching real PDS behaviour where
 * the CID is content-addressed.
 */
function cidOf(value: unknown): string {
	const hash = createHash("sha256")
		.update(JSON.stringify(value ?? null))
		.digest("hex");
	return `bafyreig${hash.slice(0, 52)}`;
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
		const text = new TextDecoder().decode(
			body instanceof ArrayBuffer ? new Uint8Array(body) : body,
		);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text;
		}
	}
	// Streams, FormData, Blob, etc. -- not used in our tests.
	return undefined;
}
