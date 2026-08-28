import type { ActorResolver } from "@atcute/identity-resolver";
import type { DirectPdsDidDocumentResolver } from "@emdash-cms/registry-client/direct-pds";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import {
	PublisherSnapshotError,
	readPublisherVerificationSnapshot,
} from "../src/verification/pds.js";

const PUBLISHER_DID = "did:plc:publisher";
const PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIgF0Ia8m10fS1OqIIOB4JeFOEW4V9LnmQWXBI/94ygwf5ndmVyc2lvbgHQAQFxEiAXQhrybXR9LU6ogg4Hgl4U4RbhX0ueZBZcEj/3jKDB/qZjZGlkcWRpZDpwbGM6cHVibGlzaGVyY3Jldm0zbXU1cHVrNmI2MjJsY3NpZ1hAfPdGrehe1wc5/9jLZsz7MEZJI91lsiZC0tGL4jhbekMBbNmWL5c4OgOzG3bN4A32fSgWlBJfmBCTIQGAOjxC6WRkYXRh2CpYJQABcRIgImvcP6xplLZZ8rVKPwE2OLRyr8gA22oR4aV7g5ghQVRkcHJldvZndmVyc2lvbgPeAQFxEiAia9w/rGmUtlnytUo/ATY4tHKvyADbahHhpXuDmCFBVKJhZYKkYWtYMmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZS9nYWxsZXJ5YXAAYXT2YXbYKlglAAFxEiC+MQX3czvJZMmZLZQZ/si/I2qGq7MUqt/eyLEtrxB416Rha1VyZWxlYXNlL2dhbGxlcnk6MS4wLjBhcBgjYXT2YXbYKlglAAFxEiBWzwMNfBEYUPmMFjzpw+7caiK0pxFOsjDG+NB4L4vb/mFs9s0CAXESIL4xBfdzO8lkyZktlBn+yL8jaoarsxSq397IsS2vEHjXqGJpZHhJYXQ6Ly9kaWQ6cGxjOnB1Ymxpc2hlci9jb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWRzbHVnZ2dhbGxlcnlkdHlwZW1lbWRhc2gtcGx1Z2luZSR0eXBleCpjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGVnYXV0aG9yc4GhZG5hbWV1cHVibGlzaGVyLmV4YW1wbGUuY29tZ2xpY2Vuc2VjTUlUaHNlY3VyaXR5gaFlZW1haWx4HnNlY3VyaXR5QHB1Ymxpc2hlci5leGFtcGxlLmNvbWtsYXN0VXBkYXRlZHgYMjAyNi0wOC0yOFQxNTo1Mzo0My44ODVa";

function resolver(): ActorResolver {
	return {
		resolve: async () => ({
			did: PUBLISHER_DID,
			handle: "publisher.example.com",
			pds: "https://pds.example.com",
		}),
	};
}

function proofResolver(): DirectPdsDidDocumentResolver {
	return {
		resolve: () =>
			Promise.resolve({
				id: PUBLISHER_DID,
				alsoKnownAs: ["at://publisher.example.com"],
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: "zDnaeXJ3AAAYhS8fq5tKwBusKZeBoQQeaZyUE2KepuqMa6FuF",
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
				],
			}),
	};
}

function profileProofResponse(tampered = false): Response {
	const bytes = Uint8Array.from(atob(PROFILE_PROOF), (character) => character.charCodeAt(0));
	if (tampered) bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
	return new Response(bytes, { headers: { "content-type": "application/vnd.ipld.car" } });
}

function release(version: string, packageSlug = "gallery") {
	return {
		uri: `at://${PUBLISHER_DID}/${NSID.packageRelease}/${packageSlug}:${version}`,
		cid: `bafy${packageSlug}${version.replaceAll(".", "")}`,
		value: { package: packageSlug, version },
	};
}

function snapshotFetch(
	options: { privateAddress?: boolean; proposedExists?: boolean; tamperedProfile?: boolean } = {},
) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer:
					url.searchParams.get("type") === "A"
						? [{ type: 1, data: options.privateAddress ? "10.0.0.1" : "93.184.216.34" }]
						: [],
			});
		}
		if (url.pathname === "/xrpc/com.atproto.sync.getRecord") {
			return profileProofResponse(options.tamperedProfile);
		}
		if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
			expect(url.searchParams.has("rkeyStart")).toBe(false);
			expect(url.searchParams.has("rkeyEnd")).toBe(false);
			if (url.searchParams.get("cursor") === null) {
				return Response.json({
					records: [release("9.0.0", "other"), release("1.9.0"), release("1.10.0")],
					cursor: "page-2",
				});
			}
			return Response.json({
				records: [
					release("not-semver", "unrelated"),
					release("2.0.0-rc.1"),
					...(options.proposedExists ? [release("2.0.0")] : []),
				],
			});
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

describe("publisher verification snapshot", () => {
	it("uses a signed repository proof instead of an unverified profile response", async () => {
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "cloudflare-dns.com") {
				return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
			}
			if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
				return Response.json({
					uri: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
					cid: "bafyunverified",
					value: {
						$type: NSID.packageProfile,
						id: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
						license: "unverified",
					},
				});
			}
			if (url.pathname === "/xrpc/com.atproto.sync.getRecord") {
				return profileProofResponse();
			}
			if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
				return Response.json({ records: [release("1.0.0")] });
			}
			throw new Error(`Unexpected request: ${url.toString()} ${String(init?.method)}`);
		};

		const snapshot = await readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
			actorResolver: resolver(),
			didDocumentResolver: proofResolver(),
			fetch,
		});

		expect(snapshot.profile).toMatchObject({ value: { license: "MIT" } });
	});

	it("reads the authoritative profile, proves absence, and selects the highest semver baseline", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch(),
			}),
		).resolves.toMatchObject({
			profile: { cid: expect.stringMatching(/^b/) },
			proposedRkey: "gallery:2.0.0",
			proposedReleaseAbsent: true,
			baselineVersion: "2.0.0-rc.1",
			baseline: { cid: "bafygallery200-rc1" },
		});
	});

	it("fails when the deterministic release key already exists", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ proposedExists: true }),
			}),
		).rejects.toMatchObject({ code: "RELEASE_EXISTS" });
	});

	it("rejects a profile whose repository proof is invalid", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ tamperedProfile: true }),
			}),
		).rejects.toMatchObject({ code: "PROFILE_INVALID" });
	});

	it("rejects private PDS resolution before record egress", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ privateAddress: true }),
			}),
		).rejects.toBeInstanceOf(PublisherSnapshotError);
	});
});
