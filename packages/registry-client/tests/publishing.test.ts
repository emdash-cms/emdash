import { ClientResponseError } from "@atcute/client";
import { describe, expect, it, vi } from "vitest";

import type { Did } from "../src/credentials/index.js";
import { PublishingClient } from "../src/publishing/index.js";

function buildHandler(responses: Record<string, { status: number; body: unknown }>): {
	handler: (pathname: string, init: RequestInit) => Promise<Response>;
	calls: Array<{ pathname: string; init: RequestInit }>;
} {
	const calls: Array<{ pathname: string; init: RequestInit }> = [];
	const handler = vi.fn(async (pathname: string, init: RequestInit) => {
		calls.push({ pathname, init });
		// `pathname` from atcute is `/xrpc/<nsid>` plus an optional `?...` query.
		const cleanPath = pathname.split("?")[0]!;
		const match = responses[cleanPath];
		if (!match) {
			return new Response(JSON.stringify({ error: "TestNotConfigured" }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(match.body), {
			status: match.status,
			headers: { "content-type": "application/json" },
		});
	});
	return { handler, calls };
}

describe("PublishingClient", () => {
	const did = "did:plc:abc123" as Did;
	const pds = "https://pds.example.com";

	it("putRecord posts to com.atproto.repo.putRecord with the right body", async () => {
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.putRecord": {
				status: 200,
				body: {
					uri: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/gallery",
					cid: "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe",
				},
			},
		});

		const client = PublishingClient.fromHandler({ handler, did, pds });
		const result = await client.putRecord({
			collection: "com.emdashcms.experimental.package.profile",
			rkey: "gallery",
			record: {
				$type: "com.emdashcms.experimental.package.profile",
				type: "emdash-plugin",
				license: "MIT",
				authors: [{ name: "Alice" }],
				security: [{ email: "security@example.com" }],
			},
		});

		expect(result.uri).toContain("did:plc:abc123");
		expect(result.cid).toBeTruthy();

		const call = calls[0]!;
		expect(call.pathname).toMatch(/^\/xrpc\/com\.atproto\.repo\.putRecord/);
		// atcute issues procedures with a lowercase "post" method. We assert the
		// literal value so a regression in either direction (atcute upper-cases,
		// or our wrapper accidentally uses GET) trips the test.
		expect(call.init.method).toBe("post");

		const body = JSON.parse(call.init.body as string);
		expect(body).toMatchObject({
			repo: did,
			collection: "com.emdashcms.experimental.package.profile",
			rkey: "gallery",
			validate: false,
		});
	});

	it("putRecord forwards the validate flag when set", async () => {
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.putRecord": {
				status: 200,
				body: { uri: "at://did:plc:abc123/c/r", cid: "b" },
			},
		});

		const client = PublishingClient.fromHandler({ handler, did, pds });
		await client.putRecord({
			collection: "com.emdashcms.experimental.package.profile",
			rkey: "x",
			record: {},
			validate: true,
		});

		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.validate).toBe(true);
	});

	it("putRecord throws ClientResponseError on a non-2xx", async () => {
		const { handler } = buildHandler({
			"/xrpc/com.atproto.repo.putRecord": {
				status: 401,
				body: { error: "AuthRequired", message: "session expired" },
			},
		});

		const client = PublishingClient.fromHandler({ handler, did, pds });
		try {
			await client.putRecord({
				collection: "com.emdashcms.experimental.package.profile",
				rkey: "x",
				record: {},
			});
			expect.fail("expected ClientResponseError");
		} catch (err) {
			expect(err).toBeInstanceOf(ClientResponseError);
			const e = err as ClientResponseError;
			expect(e.status).toBe(401);
			expect(e.error).toBe("AuthRequired");
		}
	});

	it("getRecord queries with repo + collection + rkey params", async () => {
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.getRecord": {
				status: 200,
				body: { uri: "at://did:plc:abc123/c/r", cid: "b", value: { foo: 1 } },
			},
		});

		const client = PublishingClient.fromHandler({ handler, did, pds });
		const result = await client.getRecord({
			collection: "com.emdashcms.experimental.package.profile",
			rkey: "gallery",
		});

		expect(result.value).toEqual({ foo: 1 });
		// atcute issues queries with a lowercase "get" method.
		expect(calls[0]!.init.method).toBe("get");
		// The URL with query params is in the pathname for atcute handlers.
		expect(calls[0]!.pathname).toContain("repo=did%3Aplc%3Aabc123");
		expect(calls[0]!.pathname).toContain("collection=com.emdashcms.experimental.package.profile");
		expect(calls[0]!.pathname).toContain("rkey=gallery");
	});

	it("listRecords paginates with cursor", async () => {
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.listRecords": {
				status: 200,
				body: { records: [], cursor: "next" },
			},
		});

		const client = PublishingClient.fromHandler({ handler, did, pds });
		const result = await client.listRecords({
			collection: "com.emdashcms.experimental.package.release",
			limit: 50,
			cursor: "abc",
		});

		expect(result.cursor).toBe("next");
		expect(calls[0]!.pathname).toContain("limit=50");
		expect(calls[0]!.pathname).toContain("cursor=abc");
	});
});
