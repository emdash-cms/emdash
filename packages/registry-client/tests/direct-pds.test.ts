import {
	buildDidDocument,
	createFakePublisherFixture,
	type DidDocument,
	type FakePublisher,
	type FakePublisherFixture,
} from "@emdash-cms/atproto-test-utils";
import { describe, expect, it, vi } from "vitest";

import {
	DirectPdsClient,
	type DirectPdsClientOptions,
	type DirectPdsDidDocumentResolver,
} from "../src/direct-pds/index.js";

const ALICE_DID = "did:plc:alice00000000000000000";
const DAVE_DID = "did:plc:dave000000000000000000";

interface PublisherHarness {
	fixture: FakePublisherFixture;
	publisher: FakePublisher;
	resolver: DirectPdsDidDocumentResolver;
	fetch: typeof fetch;
}

async function createPublisher(): Promise<PublisherHarness> {
	const fixture = createFakePublisherFixture();
	const publisher = await fixture.createPublisher({
		did: ALICE_DID,
		handle: "alice.test",
	});
	await publisher.publishProfile({
		slug: "gallery",
		license: "MIT",
		securityEmail: "security@alice.test",
	});
	await publisher.publishRelease({
		slug: "gallery",
		version: "1.0.0",
		checksum: "bciqexample",
		url: "https://artifacts.example/gallery-1.0.0.tar.gz",
	});
	const resolver = resolverFor(fixture);
	const fetch = pdsFetch(fixture);
	return { fixture, publisher, resolver, fetch };
}

function resolverFor(fixture: FakePublisherFixture): DirectPdsDidDocumentResolver {
	return {
		async resolve(did) {
			const document = fixture.didResolver.resolve(did);
			if (!document) throw new Error("DID not found");
			return document;
		},
	};
}

function pdsFetch(fixture: FakePublisherFixture): typeof fetch {
	return async (input, init) => {
		const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
		return fixture.pds.handle(`${url.pathname}${url.search}`, init);
	};
}

function client(harness: PublisherHarness, overrides: Partial<DirectPdsClientOptions> = {}) {
	return new DirectPdsClient({
		did: harness.publisher.did,
		fetch: harness.fetch,
		didDocumentResolver: harness.resolver,
		...overrides,
	});
}

describe("DirectPdsClient", () => {
	it("verifies profile and release MST inclusion against one resolved signing key", async () => {
		const harness = await createPublisher();
		const resolve = vi.fn(harness.resolver.resolve.bind(harness.resolver));
		const direct = client(harness, { didDocumentResolver: { resolve } });

		const [profile, release] = await Promise.all([
			direct.getPackageProfile("gallery"),
			direct.getPackageRelease("gallery", "1.0.0"),
		]);

		expect(profile).toMatchObject({
			uri: `at://${ALICE_DID}/com.emdashcms.experimental.package.profile/gallery`,
			rkey: "gallery",
			value: {
				id: `at://${ALICE_DID}/com.emdashcms.experimental.package.profile/gallery`,
			},
		});
		expect(release).toMatchObject({
			uri: `at://${ALICE_DID}/com.emdashcms.experimental.package.release/gallery:1.0.0`,
			rkey: "gallery:1.0.0",
			value: { package: "gallery", version: "1.0.0" },
		});
		expect(profile.cid).toMatch(/^b/);
		expect(release.cid).toMatch(/^b/);
		expect(resolve).toHaveBeenCalledOnce();
	});

	it("verifies and enumerates a complete package repository export", async () => {
		const harness = await createPublisher();

		await expect(client(harness).getPackageRepository("gallery")).resolves.toMatchObject({
			profile: {
				uri: `at://${ALICE_DID}/com.emdashcms.experimental.package.profile/gallery`,
				cid: expect.stringMatching(/^b/),
			},
			releases: [
				{
					uri: `at://${ALICE_DID}/com.emdashcms.experimental.package.release/gallery:1.0.0`,
					cid: expect.stringMatching(/^b/),
					value: { package: "gallery", version: "1.0.0" },
				},
			],
		});
		expect(harness.fixture.pds.callsTo("com.atproto.sync.getRepo")).toHaveLength(1);
		expect(harness.fixture.pds.callsTo("com.atproto.repo.listRecords")).toHaveLength(0);
	});

	it("reports a missing profile distinctly in a repository export", async () => {
		const harness = await createPublisher();
		await harness.publisher.repo.deleteRecord(
			"com.emdashcms.experimental.package.profile",
			"gallery",
		);

		await expect(client(harness).getPackageRepository("gallery")).rejects.toMatchObject({
			code: "RECORD_NOT_FOUND",
		});
	});

	it("reports a missing repository export distinctly from other PDS failures", async () => {
		const harness = await createPublisher();
		const fetch: typeof globalThis.fetch = () =>
			Promise.resolve(Response.json({ error: "RepoNotFound" }, { status: 404 }));

		await expect(client(harness, { fetch }).getPackageRepository("gallery")).rejects.toMatchObject({
			code: "REPOSITORY_NOT_FOUND",
			status: 404,
		});
	});

	it("preserves record-not-found errors from sync.getRecord", async () => {
		const harness = await createPublisher();
		const fetch: typeof globalThis.fetch = () =>
			Promise.resolve(Response.json({ error: "RecordNotFound" }, { status: 404 }));

		await expect(client(harness, { fetch }).getPackageProfile("gallery")).rejects.toMatchObject({
			code: "RECORD_NOT_FOUND",
			status: 404,
		});
	});

	it("resolves the publisher DID before fetching its repository proof", async () => {
		const harness = await createPublisher();
		const document = harness.fixture.didResolver.resolve(harness.publisher.did);
		if (!document) throw new Error("DID not found");
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
			if (url.origin === "https://plc.directory") {
				return new Response(JSON.stringify(document), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return harness.fetch(input, init);
		});
		const direct = new DirectPdsClient({ did: harness.publisher.did, fetch });

		await expect(direct.getPackageProfile("gallery")).resolves.toMatchObject({
			cid: expect.stringMatching(/^b/),
			rkey: "gallery",
		});
		const didRequest = fetch.mock.calls[0]?.[0];
		const didRequestUrl =
			didRequest instanceof Request
				? didRequest.url
				: didRequest instanceof URL
					? didRequest.href
					: didRequest;
		expect(didRequestUrl).toBe(
			"https://plc.directory/" + encodeURIComponent(harness.publisher.did),
		);
	});

	it("retries publisher resolution after a transient failure", async () => {
		const harness = await createPublisher();
		const resolve = vi.fn(async (did: Parameters<DirectPdsDidDocumentResolver["resolve"]>[0]) => {
			if (resolve.mock.calls.length === 1) throw new Error("temporary resolver failure");
			return harness.resolver.resolve(did);
		});
		const direct = client(harness, { didDocumentResolver: { resolve } });

		await expect(direct.getPackageProfile("gallery")).rejects.toMatchObject({
			code: "DID_RESOLUTION_FAILED",
		});
		await expect(direct.getPackageProfile("gallery")).resolves.toMatchObject({
			rkey: "gallery",
		});
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("rejects a valid proof when the resolved DID document supplies another publisher's key", async () => {
		const harness = await createPublisher();
		const dave = await harness.fixture.createPublisher({ did: DAVE_DID });
		const signingKeyMultibase = dave.repo.didKey().replace(/^did:key:/, "");
		const wrongDocument = buildDidDocument({
			did: harness.publisher.did,
			signingKeyMultibase,
			pdsEndpoint: harness.fixture.pdsBaseUrl,
		});

		await expect(
			client(harness, {
				didDocumentResolver: { resolve: () => Promise.resolve(wrongDocument) },
			}).getPackageProfile("gallery"),
		).rejects.toMatchObject({ code: "RECORD_PROOF_INVALID" });
	});

	it("rejects a tampered repository proof", async () => {
		const harness = await createPublisher();
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const response = await harness.fetch(input, init);
			const bytes = new Uint8Array(await response.arrayBuffer());
			bytes.set([(bytes.at(-1) ?? 0) ^ 0xff], bytes.length - 1);
			return new Response(bytes, { status: response.status, headers: response.headers });
		};

		await expect(client(harness, { fetch }).getPackageProfile("gallery")).rejects.toMatchObject({
			code: "RECORD_PROOF_INVALID",
		});
	});

	it("lexicon-validates the signed record after proof verification", async () => {
		const harness = await createPublisher();
		await harness.publisher.repo.putRecord("com.emdashcms.experimental.package.profile", "broken", {
			$type: "com.emdashcms.experimental.package.profile",
			id: "not-an-at-uri",
		});

		await expect(client(harness).getPackageProfile("broken")).rejects.toMatchObject({
			code: "PROFILE_LEXICON_INVALID",
		});
	});

	it("rejects non-CAR success responses", async () => {
		const harness = await createPublisher();
		const fetch: typeof globalThis.fetch = () =>
			Promise.resolve(
				new Response("{}", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await expect(client(harness, { fetch }).getPackageProfile("gallery")).rejects.toMatchObject({
			code: "PDS_RESPONSE_TYPE_INVALID",
		});
	});

	it("bounds response bytes before repository verification", async () => {
		const harness = await createPublisher();
		const fetch: typeof globalThis.fetch = () =>
			Promise.resolve(
				new Response(new Uint8Array(64), {
					status: 200,
					headers: { "Content-Type": "application/vnd.ipld.car" },
				}),
			);

		await expect(
			client(harness, { fetch, maxResponseBytes: 32 }).getPackageProfile("gallery"),
		).rejects.toMatchObject({ code: "PDS_RESPONSE_TOO_LARGE" });
	});

	it("times out a PDS request whose fetch never settles", async () => {
		const harness = await createPublisher();
		const fetch: typeof globalThis.fetch = () => new Promise(() => undefined);

		await expect(
			client(harness, { fetch, requestTimeoutMs: 10 }).getPackageProfile("gallery"),
		).rejects.toMatchObject({ code: "PDS_REQUEST_TIMEOUT" });
	});

	it("rejects a DID document with a non-HTTPS PDS endpoint", async () => {
		const harness = await createPublisher();
		const document = harness.fixture.didResolver.resolve(harness.publisher.did);
		if (!document) throw new Error("DID not found");
		const insecure: DidDocument = {
			...document,
			service: document.service.map((service) => ({
				...service,
				serviceEndpoint: "http://pds.example.test",
			})),
		};

		await expect(
			client(harness, {
				didDocumentResolver: { resolve: () => Promise.resolve(insecure) },
			}).getPackageProfile("gallery"),
		).rejects.toMatchObject({ code: "PDS_ENDPOINT_INVALID" });
	});
});
