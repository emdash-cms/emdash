import { encode } from "@atcute/cbor";
import * as CID from "@atcute/cid";
import type { PackageRelease } from "@emdash-cms/registry-lexicons";
import { describe, expect, it, vi } from "vitest";

import profileFixture from "../../registry-verification/fixtures/records/profile.json";
import releaseFixture from "../../registry-verification/fixtures/records/release.json";
import {
	DirectPdsClient,
	DirectPdsReadError,
	selectSemverBaseline,
} from "../src/direct-pds/index.js";

const did = "did:plc:publisher";
const pds = "https://pds.example.com";
const profileCid = await recordCid(profileFixture);
const releaseCid = await recordCid(releaseFixture);

describe("DirectPdsClient", () => {
	it("reads and validates a profile directly from the configured PDS", async () => {
		const fetch = routeFetch(() => profileResponse());
		const client = new DirectPdsClient({ did, pds, fetch });

		const result = await client.getPackageProfile("gallery");

		expect(result).toMatchObject({ cid: profileCid, rkey: "gallery", value: { name: "Gallery" } });
		expect(fetch).toHaveBeenCalledOnce();
		const request = new URL(String(fetch.mock.calls[0]?.[0]));
		expect(request.origin).toBe(pds);
		expect(request.pathname).toBe("/xrpc/com.atproto.repo.getRecord");
		expect(request.searchParams.get("repo")).toBe(did);
	});

	it("never returns malformed profile values as typed records", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => profileResponse({ nope: true })),
		});
		await expect(client.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "PROFILE_LEXICON_INVALID",
		});
	});

	it("requires an authoritative CID and canonical package identity", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() =>
				jsonResponse({
					uri: `at://${did}/com.emdashcms.experimental.package.profile/gallery`,
					value: profileFixture,
				}),
			),
		});
		await expect(client.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "RECORD_CID_MISSING",
		});
		await expect(client.listPackageReleases("gallery:other")).rejects.toMatchObject({
			code: "RELEASE_IDENTITY_MISMATCH",
		});
	});

	it("rejects malformed record CIDs", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => profileResponse(profileFixture, "not-a-cid")),
		});

		await expect(client.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "RECORD_CID_INVALID",
		});
	});

	it("rejects profile values that do not match their claimed CID", async () => {
		const value = { ...structuredClone(profileFixture), name: "Tampered Gallery" };
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => profileResponse(value, profileCid)),
		});

		await expect(client.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "RECORD_CID_MISMATCH",
		});
	});

	it("reads one release and enforces its package, version, and rkey", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => releaseResponse(releaseFixture)),
		});
		await expect(client.getPackageRelease("gallery", "1.2.3")).resolves.toMatchObject({
			rkey: "gallery:1.2.3",
			value: { package: "gallery", version: "1.2.3" },
		});
	});

	it("rejects malformed and identity-confused releases", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => releaseResponse({ ...releaseFixture, package: "other" })),
		});
		await expect(client.getPackageRelease("gallery", "1.2.3")).rejects.toMatchObject({
			code: "RELEASE_IDENTITY_MISMATCH",
		});
	});

	it("rejects a single release value that does not match its claimed CID", async () => {
		const value = structuredClone(releaseFixture);
		value.artifacts.package.url = "https://github.com/example/gallery/releases/tampered.tar.gz";
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => releaseResponse(value, releaseCid)),
		});

		await expect(client.getPackageRelease("gallery", "1.2.3")).rejects.toMatchObject({
			code: "RECORD_CID_MISMATCH",
		});
	});

	it("enumerates bounded pages and selects the highest-semver baseline regardless of order", async () => {
		const [oneTwo, prerelease, oneTen, two, zeroNine] = await Promise.all([
			releaseRecord("1.2.0"),
			releaseRecord("2.0.0-rc.1"),
			releaseRecord("1.10.0"),
			releaseRecord("2.0.0"),
			releaseRecord("0.9.0"),
		]);
		const pages = new Map<string | null, unknown>([
			[null, listResponse([oneTwo, prerelease], "next-page")],
			["next-page", listResponse([oneTen, two, zeroNine])],
		]);
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch((url) => jsonResponse(pages.get(url.searchParams.get("cursor")))),
		});

		const releases = await client.listPackageReleases("gallery", {
			maxRecords: 10,
			pageSize: 2,
		});
		expect(selectSemverBaseline(releases, { excludeRkey: "gallery:9.0.0" })).toMatchObject({
			value: { version: "2.0.0" },
		});
	});

	it("uses an empty baseline for a first release", () => {
		expect(selectSemverBaseline([], { excludeRkey: "gallery:1.0.0" })).toBeNull();
	});

	it("excludes the proposed release key before selecting a baseline", () => {
		const releases = [typedRelease("1.0.0"), typedRelease("2.0.0")];
		expect(selectSemverBaseline(releases, { excludeRkey: "gallery:2.0.0" })).toMatchObject({
			value: { version: "1.0.0" },
		});
	});

	it("rejects a baseline candidate from another package", () => {
		const release = typedRelease("9.0.0");
		release.rkey = "other:9.0.0";
		release.value.package = "other";
		expect(() => selectSemverBaseline([release], { excludeRkey: "gallery:10.0.0" })).toThrowError(
			expect.objectContaining({ code: "RELEASE_IDENTITY_MISMATCH" }),
		);
	});

	it("rejects truncation instead of selecting from an incomplete enumeration", async () => {
		const record = await releaseRecord("1.0.0");
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([record], "more"))),
		});
		await expect(
			client.listPackageReleases("gallery", { maxRecords: 1, pageSize: 1 }),
		).rejects.toMatchObject({ code: "ENUMERATION_TRUNCATED" });
	});

	it("accepts legal short pages until enumeration completes", async () => {
		const [one, two, three] = await Promise.all([
			releaseRecord("1.0.0"),
			releaseRecord("2.0.0"),
			releaseRecord("3.0.0"),
		]);
		const pages = new Map<string | null, unknown>([
			[null, listResponse([one], "second")],
			["second", listResponse([two], "third")],
			["third", listResponse([three])],
		]);
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch((url) => jsonResponse(pages.get(url.searchParams.get("cursor")))),
		});

		await expect(
			client.listPackageReleases("gallery", { maxRecords: 3, pageSize: 3 }),
		).resolves.toHaveLength(3);
	});

	it("accepts an exact-boundary enumeration without a continuation cursor", async () => {
		const records = await Promise.all([releaseRecord("1.0.0"), releaseRecord("2.0.0")]);
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse(records))),
		});

		await expect(
			client.listPackageReleases("gallery", { maxRecords: 2, pageSize: 2 }),
		).resolves.toHaveLength(2);
	});

	it("rejects a PDS response that exceeds the remaining record bound", async () => {
		const records = await Promise.all([
			releaseRecord("1.0.0"),
			releaseRecord("2.0.0"),
			releaseRecord("3.0.0"),
		]);
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse(records))),
		});

		await expect(
			client.listPackageReleases("gallery", { maxRecords: 2, pageSize: 2 }),
		).rejects.toMatchObject({ code: "ENUMERATION_TRUNCATED" });
	});

	it("rejects a continuation cursor that makes no record progress", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([], "same"))),
		});
		await expect(
			client.listPackageReleases("gallery", { maxRecords: 10, pageSize: 5 }),
		).rejects.toMatchObject({ code: "ENUMERATION_TRUNCATED" });
	});

	it("rejects repeated cursors even when each page contains records", async () => {
		let page = 0;
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(async () =>
				jsonResponse(listResponse([await releaseRecord(`${++page}.0.0`)], "same")),
			),
		});
		await expect(
			client.listPackageReleases("gallery", { maxRecords: 10, pageSize: 5 }),
		).rejects.toMatchObject({ code: "ENUMERATION_CURSOR_REPEATED" });
	});

	it("rejects duplicate rkeys and malformed target records as ambiguous", async () => {
		const duplicate = await releaseRecord("1.0.0");
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([duplicate, duplicate]))),
		});
		await expect(client.listPackageReleases("gallery")).rejects.toMatchObject({
			code: "RELEASE_ENUMERATION_AMBIGUOUS",
		});

		const malformed = await releaseRecord("1.0.0");
		malformed.value = { ...malformed.value, version: "not-semver" };
		const malformedClient = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([malformed]))),
		});
		await expect(malformedClient.listPackageReleases("gallery")).rejects.toBeInstanceOf(
			DirectPdsReadError,
		);
	});

	it("rejects an enumerated release value that does not match its claimed CID", async () => {
		const record = await releaseRecord("1.0.0");
		record.value.artifacts.package.url =
			"https://github.com/example/gallery/releases/tampered.tar.gz";
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([record]))),
		});

		await expect(client.listPackageReleases("gallery")).rejects.toMatchObject({
			code: "RECORD_CID_MISMATCH",
		});
	});

	it("rejects oversized declared and streamed response bodies", async () => {
		const declaredClient = new DirectPdsClient({
			did,
			pds,
			maxResponseBytes: 10,
			fetch: routeFetch(
				() =>
					new Response("{}", {
						headers: { "content-length": "11", "content-type": "application/json" },
					}),
			),
		});
		await expect(declaredClient.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "PDS_RESPONSE_TOO_LARGE",
		});

		const streamedClient = new DirectPdsClient({
			did,
			pds,
			maxResponseBytes: 3,
			fetch: routeFetch(() => streamedResponse([Uint8Array.of(1, 2), Uint8Array.of(3, 4)])),
		});
		await expect(streamedClient.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "PDS_RESPONSE_TOO_LARGE",
		});
	});

	it("times out a stalled direct-PDS request", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			requestTimeoutMs: 10,
			fetch: vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch,
		});

		await expect(client.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "PDS_REQUEST_TIMEOUT",
		});
	});

	it("times out a stalled direct-PDS response body", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			requestTimeoutMs: 10,
			fetch: routeFetch(() => stalledResponse()),
		});

		await expect(client.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "PDS_REQUEST_TIMEOUT",
		});
	});

	it("composes an external abort signal without starting a pre-aborted request", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = routeFetch(() => profileResponse());
		const client = new DirectPdsClient({ did, pds, signal: controller.signal, fetch });

		await expect(client.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "PDS_REQUEST_ABORTED",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("accepts valid responses within explicit request bounds", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			requestTimeoutMs: 1_000,
			maxResponseBytes: 100_000,
			fetch: routeFetch(() => profileResponse()),
		});

		await expect(client.getPackageProfile("gallery")).resolves.toMatchObject({ cid: profileCid });
	});

	it.each([
		{ requestTimeoutMs: 0 },
		{ requestTimeoutMs: Number.POSITIVE_INFINITY },
		{ requestTimeoutMs: 2_147_483_648 },
		{ maxResponseBytes: 0 },
		{ maxResponseBytes: 1.5 },
	])("rejects invalid request limits: %o", (options) => {
		expect(() => new DirectPdsClient({ did, pds, ...options })).toThrow(RangeError);
	});
});

function routeFetch(respond: (url: URL) => Response | Promise<Response>) {
	return vi.fn(async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== pds) throw new Error(`Unexpected non-PDS request: ${url}`);
		return await respond(url);
	}) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function profileResponse(value: unknown = profileFixture, cid?: string): Promise<Response> {
	return jsonResponse({
		uri: `at://${did}/com.emdashcms.experimental.package.profile/gallery`,
		cid: cid ?? (await recordCid(value)),
		value,
	});
}

async function releaseResponse(value: unknown, cid?: string): Promise<Response> {
	return jsonResponse({
		uri: `at://${did}/com.emdashcms.experimental.package.release/gallery:1.2.3`,
		cid: cid ?? (await recordCid(value)),
		value,
	});
}

function listResponse(records: unknown[], cursor?: string) {
	return { records, ...(cursor ? { cursor } : {}) };
}

async function releaseRecord(version: string) {
	const value = { ...structuredClone(releaseFixture), version };
	return {
		uri: `at://${did}/com.emdashcms.experimental.package.release/gallery:${version}`,
		cid: await recordCid(value),
		value,
	};
}

function typedRelease(version: string) {
	return {
		uri: `at://${did}/com.emdashcms.experimental.package.release/gallery:${version}`,
		cid: releaseCid,
		rkey: `gallery:${version}`,
		value: { ...structuredClone(releaseFixture), version } as PackageRelease.Main,
	};
}

async function recordCid(value: unknown): Promise<string> {
	return CID.toString(await CID.create(CID.CODEC_DCBOR, encode(value)));
}

function streamedResponse(chunks: Uint8Array[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

function stalledResponse(): Response {
	return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
		headers: { "content-type": "application/json" },
	});
}
