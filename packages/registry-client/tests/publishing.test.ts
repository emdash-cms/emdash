import { encode } from "@atcute/cbor";
import * as CID from "@atcute/cid";
import { ClientResponseError } from "@atcute/client";
import { describe, expect, it, vi } from "vitest";

import type { Did } from "../src/credentials/index.js";
import { PublishingClient, createDelegatedRelease } from "../src/publishing/index.js";

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
			// validate: true is the default. The PDS lexicon-validates every
			// record we write; opting out (skipValidation: true) is a footgun.
			validate: true,
		});
	});

	it("putRecord opts out of lexicon validation when skipValidation is set", async () => {
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.putRecord": {
				status: 200,
				body: { uri: "at://did:plc:abc123/c/r", cid: "b" },
			},
		});

		const client = PublishingClient.fromHandler({ handler, did, pds });
		await client.unsafePutRecord({
			collection: "com.emdashcms.experimental.package.profile",
			rkey: "x",
			record: {},
			skipValidation: true,
		});

		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.validate).toBe(false);
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
			// Use unsafePutRecord so we can pass an opaque record without
			// satisfying the registry-lexicons typed shape -- this test is
			// about the error-mapping path, not the body.
			await client.unsafePutRecord({
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

	it("applyWrites batches create/update/delete in a single XRPC call", async () => {
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.applyWrites": {
				status: 200,
				body: {
					results: [
						{
							$type: "com.atproto.repo.applyWrites#createResult",
							uri: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/x",
							cid: "bafy...",
						},
						{
							$type: "com.atproto.repo.applyWrites#updateResult",
							uri: "at://did:plc:abc123/com.emdashcms.experimental.package.release/x:1.0.0",
							cid: "bafy...",
						},
					],
				},
			},
		});

		const client = PublishingClient.fromHandler({ handler, did, pds });
		const result = await client.applyWrites({
			writes: [
				{
					op: "create",
					collection: "com.emdashcms.experimental.package.profile",
					rkey: "x",
					// Cast: real callers build records via the lexicon types; the
					// test asserts shape, not record contents.
					record: { foo: 1 } as never,
				},
				{
					op: "update",
					collection: "com.emdashcms.experimental.package.release",
					rkey: "x:1.0.0",
					record: { bar: 2 } as never,
				},
			],
		});

		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toMatchObject({ op: "create" });
		expect(result.results[1]).toMatchObject({ op: "update" });

		// One XRPC call, lexicon-validate enabled by default.
		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.validate).toBe(true);
		expect(body.writes).toHaveLength(2);
	});
});

describe("createDelegatedRelease", () => {
	const did = "did:plc:abc123" as Did;
	const release = {
		$type: "com.emdashcms.experimental.package.release" as const,
		package: "gallery",
		version: "1.0.0",
		artifacts: {
			package: {
				url: "https://example.com/gallery-1.0.0.tgz",
				checksum: "bciqkkpvkbtfcwq6kjkbq3kgjxe5j6ihzkxlfxkzqhwzaaaa3wkbq3a",
			},
		},
	};

	it("creates exactly one deterministic release record", async () => {
		const uri = "at://did:plc:abc123/com.emdashcms.experimental.package.release/gallery:1.0.0";
		const cid = await recordCid(release);
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.createRecord": {
				status: 200,
				body: { uri, cid },
			},
		});

		await expect(createDelegatedRelease({ handler, did, release })).resolves.toEqual({
			uri,
			cid,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.pathname).toBe("/xrpc/com.atproto.repo.createRecord");
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
			repo: did,
			collection: "com.emdashcms.experimental.package.release",
			rkey: "gallery:1.0.0",
			record: release,
			validate: false,
		});
	});

	it.each([
		["invalid lexicon", { ...release, artifacts: {} }],
		["invalid package slug", { ...release, package: "Gallery" }],
		["non-canonical version", { ...release, version: "1.0.0+build" }],
	])("rejects %s before making a request", async (_name, candidate) => {
		const { handler, calls } = buildHandler({});

		await expect(
			createDelegatedRelease({ handler, did, release: candidate as typeof release }),
		).rejects.toBeInstanceOf(TypeError);
		expect(calls).toHaveLength(0);
	});

	it("rejects an invalid publisher DID before making a request", async () => {
		const { handler, calls } = buildHandler({});

		await expect(
			createDelegatedRelease({ handler, did: "not-a-did" as Did, release }),
		).rejects.toThrow("Invalid delegated release publisher DID");
		expect(calls).toHaveLength(0);
	});

	it("captures accessor-backed options exactly once", async () => {
		let didReads = 0;
		const calls: Array<{ repo: string }> = [];
		const handler = async (_pathname: string, init: RequestInit): Promise<Response> => {
			const input = JSON.parse(init.body as string);
			calls.push({ repo: input.repo });
			return new Response(
				JSON.stringify({
					uri: `at://${input.repo}/${input.collection}/${input.rkey}`,
					cid: await recordCid(input.record),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const options = {
			handler,
			get did(): Did {
				didReads += 1;
				return (didReads === 1 ? did : "not-a-did") as Did;
			},
			release,
		};

		await expect(createDelegatedRelease(options)).resolves.toMatchObject({
			uri: "at://did:plc:abc123/com.emdashcms.experimental.package.release/gallery:1.0.0",
		});
		expect(didReads).toBe(1);
		expect(calls).toEqual([{ repo: did }]);
	});

	it("binds validation, serialization, and CID verification to one snapshot", async () => {
		const mutableRelease = structuredClone(release);
		const handler = async (_pathname: string, init: RequestInit): Promise<Response> => {
			const input = JSON.parse(init.body as string);
			mutableRelease.version = "2.0.0";
			return new Response(
				JSON.stringify({
					uri: "at://did:plc:abc123/com.emdashcms.experimental.package.release/gallery:1.0.0",
					cid: await recordCid(input.record),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		await expect(
			createDelegatedRelease({ handler, did, release: mutableRelease }),
		).resolves.toEqual({
			uri: "at://did:plc:abc123/com.emdashcms.experimental.package.release/gallery:1.0.0",
			cid: await recordCid(release),
		});
	});

	it("does not fall back when create conflicts", async () => {
		const { handler, calls } = buildHandler({
			"/xrpc/com.atproto.repo.createRecord": {
				status: 400,
				body: { error: "RecordAlreadyExists" },
			},
		});

		await expect(createDelegatedRelease({ handler, did, release })).rejects.toBeInstanceOf(
			ClientResponseError,
		);
		expect(calls).toHaveLength(1);
	});

	it("rejects a response for a different record identity", async () => {
		const cid = await recordCid(release);
		const { handler } = buildHandler({
			"/xrpc/com.atproto.repo.createRecord": {
				status: 200,
				body: {
					uri: "at://did:plc:other/com.emdashcms.experimental.package.release/gallery:1.0.0",
					cid,
				},
			},
		});

		await expect(createDelegatedRelease({ handler, did, release })).rejects.toThrow(
			"invalid delegated release identity",
		);
	});

	it("rejects a fragment-bearing record URI", async () => {
		const cid = await recordCid(release);
		const { handler } = buildHandler({
			"/xrpc/com.atproto.repo.createRecord": {
				status: 200,
				body: {
					uri: "at://did:plc:abc123/com.emdashcms.experimental.package.release/gallery:1.0.0#/other",
					cid,
				},
			},
		});

		await expect(createDelegatedRelease({ handler, did, release })).rejects.toThrow(
			"invalid delegated release identity",
		);
	});

	it.each([
		["malformed", "not-a-cid", "invalid delegated release CID"],
		[
			"mismatched",
			"bafyreihyrpefhacm6kkp4ql6j6udakdit7g3dmkzfriqfykhjw6cad5lrm",
			"mismatched delegated release CID",
		],
	])("rejects a %s response CID", async (_name, cid, message) => {
		const { handler } = buildHandler({
			"/xrpc/com.atproto.repo.createRecord": {
				status: 200,
				body: {
					uri: "at://did:plc:abc123/com.emdashcms.experimental.package.release/gallery:1.0.0",
					cid,
				},
			},
		});

		await expect(createDelegatedRelease({ handler, did, release })).rejects.toThrow(message);
	});
});

async function recordCid(value: unknown): Promise<string> {
	return CID.toString(await CID.create(CID.CODEC_DCBOR, encode(value)));
}
