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
const profileCid = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
const releaseCid = "bafyreifb6f5m2qvxrgxe3zpl6mu3r2m4zqas7m4wwdmy3p5l5bqv6zqjii";

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

	it("enumerates bounded pages and selects the highest-semver baseline regardless of order", async () => {
		const pages = new Map<string | null, unknown>([
			[null, listResponse([releaseRecord("1.2.0"), releaseRecord("2.0.0-rc.1")], "next-page")],
			[
				"next-page",
				listResponse([releaseRecord("1.10.0"), releaseRecord("2.0.0"), releaseRecord("0.9.0")]),
			],
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
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([releaseRecord("1.0.0")], "more"))),
		});
		await expect(
			client.listPackageReleases("gallery", { maxRecords: 1, pageSize: 1 }),
		).rejects.toMatchObject({ code: "ENUMERATION_TRUNCATED" });
	});

	it("bounds cursor-only pages and rejects repeated cursors", async () => {
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([], "same"))),
		});
		await expect(
			client.listPackageReleases("gallery", { maxRecords: 10, pageSize: 5 }),
		).rejects.toMatchObject({ code: "ENUMERATION_CURSOR_REPEATED" });
	});

	it("rejects duplicate rkeys and malformed target records as ambiguous", async () => {
		const duplicate = releaseRecord("1.0.0");
		const client = new DirectPdsClient({
			did,
			pds,
			fetch: routeFetch(() => jsonResponse(listResponse([duplicate, duplicate]))),
		});
		await expect(client.listPackageReleases("gallery")).rejects.toMatchObject({
			code: "RELEASE_ENUMERATION_AMBIGUOUS",
		});

		const malformed = releaseRecord("1.0.0");
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
});

function routeFetch(respond: (url: URL) => Response) {
	return vi.fn(async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== pds) throw new Error(`Unexpected non-PDS request: ${url}`);
		return respond(url);
	}) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function profileResponse(value: unknown = profileFixture): Response {
	return jsonResponse({
		uri: `at://${did}/com.emdashcms.experimental.package.profile/gallery`,
		cid: profileCid,
		value,
	});
}

function releaseResponse(value: unknown): Response {
	return jsonResponse({
		uri: `at://${did}/com.emdashcms.experimental.package.release/gallery:1.2.3`,
		cid: releaseCid,
		value,
	});
}

function listResponse(records: unknown[], cursor?: string) {
	return { records, ...(cursor ? { cursor } : {}) };
}

function releaseRecord(version: string) {
	return {
		uri: `at://${did}/com.emdashcms.experimental.package.release/gallery:${version}`,
		cid: releaseCid,
		value: { ...structuredClone(releaseFixture), version },
	};
}

function typedRelease(version: string) {
	return {
		...releaseRecord(version),
		rkey: `gallery:${version}`,
		value: { ...structuredClone(releaseFixture), version } as PackageRelease.Main,
	};
}
