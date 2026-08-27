import type { ActorResolver } from "@atcute/identity-resolver";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import {
	PublisherSnapshotError,
	readPublisherVerificationSnapshot,
} from "../src/verification/pds.js";

const PUBLISHER_DID = "did:plc:publisher";

function resolver(): ActorResolver {
	return {
		resolve: async () => ({
			did: PUBLISHER_DID,
			handle: "publisher.example.com",
			pds: "https://pds.example.com",
		}),
	};
}

function release(version: string) {
	return {
		uri: `at://${PUBLISHER_DID}/${NSID.packageRelease}/gallery:${version}`,
		cid: `bafy${version.replaceAll(".", "")}`,
		value: { package: "gallery", version },
	};
}

function snapshotFetch(options: { privateAddress?: boolean; proposedExists?: boolean } = {}) {
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
		if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
			return Response.json({
				uri: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
				cid: "bafyprofile",
				value: { id: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery` },
			});
		}
		if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
			expect(url.searchParams.get("rkeyStart")).toBe("gallery:");
			expect(url.searchParams.get("rkeyEnd")).toBe("gallery:~");
			if (url.searchParams.get("cursor") === null) {
				return Response.json({
					records: [release("1.9.0"), release("1.10.0")],
					cursor: "page-2",
				});
			}
			return Response.json({
				records: [release("2.0.0-rc.1"), ...(options.proposedExists ? [release("2.0.0")] : [])],
			});
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

describe("publisher verification snapshot", () => {
	it("reads the authoritative profile, proves absence, and selects the highest semver baseline", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: snapshotFetch(),
			}),
		).resolves.toMatchObject({
			profile: { cid: "bafyprofile" },
			proposedRkey: "gallery:2.0.0",
			proposedReleaseAbsent: true,
			baselineVersion: "2.0.0-rc.1",
			baseline: { cid: "bafy200-rc1" },
		});
	});

	it("fails when the deterministic release key already exists", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: snapshotFetch({ proposedExists: true }),
			}),
		).rejects.toMatchObject({ code: "RELEASE_EXISTS" });
	});

	it("rejects private PDS resolution before record egress", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: snapshotFetch({ privateAddress: true }),
			}),
		).rejects.toBeInstanceOf(PublisherSnapshotError);
	});
});
