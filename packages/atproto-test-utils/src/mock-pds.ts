/**
 * Multi-DID in-memory PDS. Hosts FakeRepo instances and dispatches XRPC
 * requests against them. Implements both the publish-side endpoints
 * (`com.atproto.repo.applyWrites`, `putRecord`, `getRecord`-as-JSON) and the
 * aggregator-side endpoints (`com.atproto.sync.getRecord`-as-CAR,
 * `com.atproto.repo.listRecords`).
 *
 * Conforms to `@atcute/client`'s `FetchHandlerObject` so it can be plugged in
 * via `Client.fromHandler({ handler: pds })` for the publish path. The
 * aggregator-side calls go through plain `fetch` against an injected base URL,
 * so the same handler is reachable via a wrapping `fetch` shim too.
 *
 * Response shapes mirror the cirrus PDS reference implementation: CAR bytes
 * for `sync.getRecord` with `Content-Type: application/vnd.ipld.car`, JSON
 * `{ records, cursor? }` for `listRecords`, JSON `{ uri, cid, value }` for
 * `repo.getRecord`.
 */

import type { FetchHandlerObject } from "@atcute/client";

import { FakeRepo } from "./fake-repo.js";
import type { AtprotoDid } from "./types.js";

interface MockPdsCall {
	method: string;
	pathname: string;
	body?: unknown;
}

export class MockPds implements FetchHandlerObject {
	readonly calls: MockPdsCall[] = [];
	private repos = new Map<AtprotoDid, FakeRepo>();

	/** Register a repo under this PDS. Multi-tenant: the PDS hosts many DIDs. */
	mount(repo: FakeRepo): void {
		this.repos.set(repo.did, repo);
	}

	getRepo(did: AtprotoDid): FakeRepo | undefined {
		return this.repos.get(did);
	}

	/** Filter recorded calls by NSID prefix. Useful for assertions. */
	callsTo(nsid: string): MockPdsCall[] {
		return this.calls.filter((c) => c.pathname.startsWith(`/xrpc/${nsid}`));
	}

	async handle(pathname: string, init: RequestInit): Promise<Response> {
		const url = new URL(pathname, "http://mock.test");
		const method = init.method?.toLowerCase() ?? "get";

		const body = await readJsonBody(init.body);
		this.calls.push({ method, pathname, ...(body !== undefined ? { body } : {}) });

		switch (url.pathname) {
			case "/xrpc/com.atproto.repo.getRecord":
				return this.repoGetRecord(url);
			case "/xrpc/com.atproto.repo.listRecords":
				return this.repoListRecords(url);
			case "/xrpc/com.atproto.repo.applyWrites":
				return this.repoApplyWrites(body);
			case "/xrpc/com.atproto.repo.putRecord":
				return this.repoPutRecord(body);
			case "/xrpc/com.atproto.sync.getRecord":
				return this.syncGetRecord(url);
			default:
				return jsonResponse(404, {
					error: "MethodNotFound",
					message: `MockPds does not implement ${url.pathname}`,
				});
		}
	}

	/**
	 * Fetch shim for code that calls a real URL. Returns a `fetch` function
	 * that intercepts requests starting with `baseUrl` and dispatches to
	 * `handle`; everything else throws so a leaked outbound call fails loudly.
	 */
	asFetch(baseUrl: string): typeof fetch {
		const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
		return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
			const url =
				typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url);
			const target = `${url.origin}${url.pathname}${url.search}`;
			if (!target.startsWith(base)) {
				throw new Error(`MockPds.asFetch: outbound request not directed at ${base}: ${target}`);
			}
			const localPath = `${url.pathname}${url.search}`;
			const reqInit: RequestInit = init ?? {};
			if (input instanceof Request) {
				return this.handle(localPath, {
					method: input.method,
					headers: input.headers,
					body: input.body ?? undefined,
				});
			}
			return this.handle(localPath, reqInit);
		};
	}

	// ─── handlers ────────────────────────────────────────────────────────────

	private repoGetRecord(url: URL): Response {
		const did = parseDid(url.searchParams.get("repo"));
		if (!did) return invalidRequest("missing or malformed repo");
		const collection = url.searchParams.get("collection");
		const rkey = url.searchParams.get("rkey");
		if (!collection || !rkey) return invalidRequest("missing collection or rkey");
		const repo = this.repos.get(did);
		if (!repo) return notFound("RepoNotFound", `MockPds does not host ${did}`);
		const value = repo.getRecordValue(collection, rkey);
		if (value === undefined) {
			return notFound(
				"RecordNotFound",
				`Could not locate record: at://${did}/${collection}/${rkey}`,
			);
		}
		return jsonResponse(200, {
			uri: `at://${did}/${collection}/${rkey}`,
			cid: cidPlaceholder(),
			value,
		});
	}

	private repoListRecords(url: URL): Response {
		const did = parseDid(url.searchParams.get("repo"));
		if (!did) return invalidRequest("missing or malformed repo");
		const collection = url.searchParams.get("collection");
		if (!collection) return invalidRequest("missing collection");
		const repo = this.repos.get(did);
		if (!repo) return notFound("RepoNotFound", `MockPds does not host ${did}`);
		const items = repo.listRecords(collection).map((r) => ({
			uri: r.uri,
			cid: cidPlaceholder(),
			value: r.value,
		}));
		return jsonResponse(200, { records: items });
	}

	private async repoApplyWrites(body: unknown): Promise<Response> {
		if (!body || typeof body !== "object") return invalidRequest("missing body");
		const b = body as { repo?: string; writes?: Array<Record<string, unknown>> };
		const did = parseDid(b.repo);
		if (!did) return invalidRequest("missing or malformed repo");
		const repo = this.repos.get(did);
		if (!repo) return notFound("RepoNotFound", `MockPds does not host ${did}`);
		if (!Array.isArray(b.writes)) return invalidRequest("writes must be an array");
		for (const w of b.writes) {
			const op = w as {
				$type?: string;
				collection?: string;
				rkey?: string;
				value?: Record<string, unknown>;
			};
			if (op.$type !== "com.atproto.repo.applyWrites#create") {
				return invalidRequest(`MockPds only supports create writes, got ${String(op.$type)}`);
			}
			if (!op.collection || !op.rkey || !op.value) {
				return invalidRequest("create write missing collection, rkey, or value");
			}
			await repo.putRecord(op.collection, op.rkey, op.value);
		}
		return jsonResponse(200, { results: b.writes.map(() => ({})) });
	}

	private async repoPutRecord(body: unknown): Promise<Response> {
		if (!body || typeof body !== "object") return invalidRequest("missing body");
		const b = body as {
			repo?: string;
			collection?: string;
			rkey?: string;
			record?: Record<string, unknown>;
		};
		const did = parseDid(b.repo);
		if (!did) return invalidRequest("missing or malformed repo");
		const repo = this.repos.get(did);
		if (!repo) return notFound("RepoNotFound", `MockPds does not host ${did}`);
		if (!b.collection || !b.rkey || !b.record) {
			return invalidRequest("putRecord missing collection, rkey, or record");
		}
		await repo.putRecord(b.collection, b.rkey, b.record);
		return jsonResponse(200, {
			uri: `at://${did}/${b.collection}/${b.rkey}`,
			cid: cidPlaceholder(),
		});
	}

	private async syncGetRecord(url: URL): Promise<Response> {
		const did = parseDid(url.searchParams.get("did"));
		if (!did) return invalidRequest("missing or malformed did");
		const collection = url.searchParams.get("collection");
		const rkey = url.searchParams.get("rkey");
		if (!collection || !rkey) return invalidRequest("missing collection or rkey");
		const repo = this.repos.get(did);
		if (!repo) return notFound("RepoNotFound", `MockPds does not host ${did}`);
		try {
			const car = await repo.getRecordCar(collection, rkey);
			return new Response(car, {
				status: 200,
				headers: {
					"Content-Type": "application/vnd.ipld.car",
					"Content-Length": car.length.toString(),
				},
			});
		} catch (err) {
			return jsonResponse(500, {
				error: "InternalServerError",
				message: err instanceof Error ? err.message : "failed to build proof CAR",
			});
		}
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function readJsonBody(body: RequestInit["body"] | undefined): Promise<unknown> {
	if (body === null || body === undefined) return undefined;
	if (typeof body === "string") {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	if (body instanceof Uint8Array) {
		try {
			return JSON.parse(new TextDecoder().decode(body));
		} catch {
			return body;
		}
	}
	if (body instanceof ReadableStream) {
		const text = await new Response(body).text();
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return body;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function invalidRequest(message: string): Response {
	return jsonResponse(400, { error: "InvalidRequest", message });
}

function notFound(error: string, message: string): Response {
	return jsonResponse(404, { error, message });
}

function parseDid(value: string | null | undefined): AtprotoDid | null {
	if (!value) return null;
	if (!value.startsWith("did:")) return null;
	return value as AtprotoDid;
}

/**
 * `repo.getRecord` and `listRecords` return a `cid` field for each record. The
 * canonical CID is the dag-cbor hash of the record's bytes, but the publish
 * path doesn't depend on its accuracy (it never round-trips back through the
 * MST verifier — that's `sync.getRecord`'s job). We return a stable
 * placeholder so tests asserting "the call returned _some_ cid" pass without
 * us having to drag in dag-cbor encoding for the JSON path.
 *
 * If a future test needs a real CID here, replace with the actual encoder
 * call; nothing in `sync.getRecord`'s CAR shape depends on it.
 */
function cidPlaceholder(): string {
	return "bafyreigtest000000000000000000000000000000000000000000000";
}
