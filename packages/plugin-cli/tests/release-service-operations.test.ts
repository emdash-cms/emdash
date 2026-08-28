import { NSID, type PackageRelease } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import releaseFixture from "../../registry-verification/fixtures/records/release.json";
import {
	cancelDelegatedReleaseIntent,
	getDelegatedReleaseIntent,
	requestGithubOidcToken,
	submitDelegatedRelease,
} from "../src/release-service/operations.js";

const SERVICE = "https://release.example.com";
const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const ENVIRONMENT = {
	ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id-token?api-version=1",
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
	GITHUB_RUN_ID: "10000000001",
	GITHUB_RUN_ATTEMPT: "2",
};

function sourceRelease(): PackageRelease.Main {
	const release = structuredClone(releaseFixture) as PackageRelease.Main;
	release.artifacts.package.checksum = CHECKSUM;
	release.extensions = {
		[NSID.packageReleaseExtension]: {
			$type: NSID.packageReleaseExtension,
			declaredAccess: {},
			provenance: {
				url: "https://example.com/provenance.json",
				checksum: CHECKSUM,
				predicateType: "https://slsa.dev/provenance/v1",
				sourceRepository: "https://github.com/example/gallery",
				builderId:
					"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
			},
		},
	};
	return release;
}

function intent(state: string) {
	return {
		id: INTENT_ID,
		publisherDid: PUBLISHER_DID,
		packageSlug: "gallery",
		version: "1.2.3",
		state,
		stateGeneration: 2,
		reasonCode: null,
		workflowId: INTENT_ID,
		expiresAt: 1_800_000_000_000,
		createdAt: 1_799_999_000_000,
		updatedAt: 1_799_999_500_000,
		result: null,
		approvalUrl: null,
	};
}

function success(data: unknown, status = 200): Response {
	return Response.json({ data, requestId: "request-1" }, { status });
}

describe("delegated release CLI operations", () => {
	it("requests a GitHub OIDC token for the release-service audience", async () => {
		const calls: Array<{ headers: Headers; url: URL }> = [];
		const token = await requestGithubOidcToken(SERVICE, {
			environment: ENVIRONMENT,
			fetch: async (input, init) => {
				calls.push({
					url: new URL(input instanceof Request ? input.url : input.toString()),
					headers: new Headers(init?.headers),
				});
				return Response.json({ value: "header.payload.signature" });
			},
		});

		expect(token).toBe("header.payload.signature");
		expect(calls[0]?.url.searchParams.get("audience")).toBe(SERVICE);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer runner-request-token");
	});

	it("submits with the stable GitHub run idempotency identity", async () => {
		const serviceRequests: Request[] = [];
		const result = await submitDelegatedRelease(
			{
				serviceUrl: SERVICE,
				publisherDid: PUBLISHER_DID,
				releaseFile: "release.json",
				wait: false,
			},
			{
				environment: ENVIRONMENT,
				readReleaseRecord: async () => sourceRelease(),
				fetch: async (input, init) => {
					const url = new URL(input instanceof Request ? input.url : input.toString());
					if (url.hostname === "token.actions.example") {
						return Response.json({ value: "header.payload.signature" });
					}
					serviceRequests.push(new Request(url, init));
					return success({ intent: intent("received"), replayed: false }, 202);
				},
			},
		);

		expect(result.state).toBe("received");
		expect(serviceRequests).toHaveLength(1);
		expect(serviceRequests[0]?.headers.get("idempotency-key")).toBe("github-run-10000000001");
		expect(serviceRequests[0]?.headers.get("authorization")).toBe(
			"Bearer header.payload.signature",
		);
	});

	it("uses fresh OIDC tokens for status and cancellation", async () => {
		let tokenCount = 0;
		const serviceRequests: Request[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "token.actions.example") {
				return Response.json({ value: `header.payload.signature-${++tokenCount}` });
			}
			serviceRequests.push(new Request(url, init));
			return success({ intent: intent(url.pathname.endsWith("/cancel") ? "cancelled" : "ready") });
		};
		const dependencies = { environment: ENVIRONMENT, fetch };

		await getDelegatedReleaseIntent(
			{ serviceUrl: SERVICE, publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
			dependencies,
		);
		await cancelDelegatedReleaseIntent(
			{ serviceUrl: SERVICE, publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
			dependencies,
		);

		expect(tokenCount).toBe(2);
		expect(serviceRequests.map((request) => request.headers.get("authorization"))).toEqual([
			"Bearer header.payload.signature-1",
			"Bearer header.payload.signature-2",
		]);
	});

	it("rejects an invalid release record before requesting OIDC", async () => {
		let fetched = false;
		await expect(
			submitDelegatedRelease(
				{
					serviceUrl: SERVICE,
					publisherDid: PUBLISHER_DID,
					releaseFile: "release.json",
				},
				{
					environment: ENVIRONMENT,
					readReleaseRecord: async () => ({ package: "gallery" }),
					fetch: async () => {
						fetched = true;
						throw new Error("unexpected fetch");
					},
				},
			),
		).rejects.toThrow("Release record file is invalid");
		expect(fetched).toBe(false);
	});

	it("rejects a blob-bearing source record before requesting OIDC", async () => {
		const release = sourceRelease();
		Object.assign(release.artifacts.package, {
			blob: {
				$type: "blob",
				ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
				mimeType: "application/gzip",
				size: 128,
			},
		});
		let fetched = false;
		await expect(
			submitDelegatedRelease(
				{
					serviceUrl: SERVICE,
					publisherDid: PUBLISHER_DID,
					releaseFile: "release.json",
				},
				{
					environment: ENVIRONMENT,
					readReleaseRecord: async () => release,
					fetch: async () => {
						fetched = true;
						throw new Error("unexpected fetch");
					},
				},
			),
		).rejects.toThrow("Release record file is invalid");
		expect(fetched).toBe(false);
	});
});
