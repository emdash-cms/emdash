import { CidLinkWrapper, CODEC_RAW, fromDigest, toString } from "@atcute/cid";
import type { PackageRelease } from "@emdash-cms/registry-lexicons";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import { reconcileReleaseRecord } from "../src/publishing/reconcile.js";

const DID = "did:plc:publisher";
const PACKAGE = "gallery";
const VERSION = "1.2.3";
const URI = `at://${DID}/${NSID.packageRelease}/${PACKAGE}:${VERSION}`;

describe("release reconciliation", () => {
	it.each([
		{
			description: "matching",
			digestByte: 1,
			result: { outcome: "exact", uri: URI, cid: "bafyexact" },
		},
		{ description: "different", digestByte: 2, result: { outcome: "conflict" } },
	])("reconciles a $description decoded blob CID link", ({ digestByte, result }) => {
		const expectedCid = fromDigest(CODEC_RAW, new Uint8Array(32).fill(1));
		const decodedCid = fromDigest(CODEC_RAW, new Uint8Array(32).fill(digestByte));
		const expectedBlob = {
			$type: "blob" as const,
			ref: { $link: toString(expectedCid) },
			mimeType: "application/gzip",
			size: 5,
		};
		const expected = structuredClone(releaseFixture) as PackageRelease.Main;
		expected.artifacts.package = {
			checksum: expected.artifacts.package.checksum,
			blob: expectedBlob,
		};
		const authoritative = structuredClone(expected);
		authoritative.artifacts.package.blob = {
			...expectedBlob,
			ref: new CidLinkWrapper(decodedCid.bytes),
		};

		expect(
			reconcileReleaseRecord(DID, PACKAGE, VERSION, expected, {
				uri: URI,
				cid: "bafyexact",
				value: authoritative,
			}),
		).toEqual(result);
	});

	it("distinguishes absence, exact semantic replay, and conflict", () => {
		const expected = structuredClone(releaseFixture) as PackageRelease.Main;
		expect(reconcileReleaseRecord(DID, PACKAGE, VERSION, expected, null)).toEqual({
			outcome: "absent",
		});
		expect(
			reconcileReleaseRecord(DID, PACKAGE, VERSION, expected, {
				uri: URI,
				cid: "bafyexact",
				value: { ...structuredClone(expected) },
			}),
		).toEqual({ outcome: "exact", uri: URI, cid: "bafyexact" });
		expect(
			reconcileReleaseRecord(DID, PACKAGE, VERSION, expected, {
				uri: URI,
				cid: "bafyconflict",
				value: { ...structuredClone(expected), version: "9.9.9" },
			}),
		).toEqual({ outcome: "conflict" });
	});
});
