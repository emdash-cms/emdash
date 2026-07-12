/**
 * record-verification unit tests.
 *
 * Covers URI parsing, DID-resolution failure surfaces, and
 * `PdsVerificationError` propagation via a stub `fetch` — the same
 * HTTP/error-shaping scope as `apps/aggregator/test/pds-verify.test.ts`.
 * The exact-CID match/mismatch assertion requires `fetchAndVerifyRecord` to
 * actually succeed, which needs a real signed CAR; building one would
 * re-implement what `@atcute/repo` already tests internally, and the
 * FakePublisher/MockPds fixture can't load inside
 * `@cloudflare/vitest-pool-workers` (see
 * `apps/aggregator/test/records-consumer.test.ts`'s header). That behaviour
 * is covered at the discovery-consumer level instead, where
 * `RecordVerificationError` with reason `RECORD_CID_MISMATCH` is asserted
 * end-to-end via an injected `verify` override.
 */

import type { DidDocument } from "@atcute/identity";
import type { Did } from "@atcute/lexicons/syntax";
import { describe, expect, it } from "vitest";

import { PdsVerificationError } from "../src/pds-verify.js";
import {
	fetchAndVerifyExactRecord,
	parseAtUri,
	RecordVerificationError,
	type DidDocumentResolverLike,
} from "../src/record-verification.js";

const TEST_DID = "did:plc:test00000000000000000000" as Did;
const RELEASE_URI = `at://${TEST_DID}/com.emdashcms.experimental.package.release/demo:1.0.0`;

class StubResolver implements DidDocumentResolverLike {
	constructor(private readonly doc: DidDocument | Error) {}
	resolve(): Promise<DidDocument> {
		if (this.doc instanceof Error) return Promise.reject(this.doc);
		return Promise.resolve(this.doc);
	}
}

function docWithoutPds(): DidDocument {
	return {
		id: TEST_DID,
		alsoKnownAs: [],
		verificationMethod: [],
		service: [],
	};
}

function docWithoutVerificationMethod(): DidDocument {
	return {
		id: TEST_DID,
		alsoKnownAs: [],
		verificationMethod: [],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: "https://pds.test.example",
			},
		],
	};
}

describe("parseAtUri", () => {
	it("parses a well-formed release AT-URI", () => {
		expect(parseAtUri(RELEASE_URI)).toEqual({
			did: TEST_DID,
			collection: "com.emdashcms.experimental.package.release",
			rkey: "demo:1.0.0",
		});
	});

	it("throws RecordVerificationError(INVALID_URI) for a malformed URI", () => {
		expect(() => parseAtUri("not-a-uri")).toThrow(RecordVerificationError);
		try {
			parseAtUri("not-a-uri");
			throw new Error("expected parseAtUri to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RecordVerificationError);
			expect((err as RecordVerificationError).reason).toBe("INVALID_URI");
		}
	});
});

describe("fetchAndVerifyExactRecord: DID resolution", () => {
	it("wraps a DID document resolver rejection as DID_RESOLUTION_FAILED", async () => {
		const resolver = new StubResolver(new Error("PLC directory unreachable"));
		await expect(
			fetchAndVerifyExactRecord({
				uri: RELEASE_URI,
				cid: "bafkreiplaceholder00000000000000000000000000000000000000000",
				didDocumentResolver: resolver,
			}),
		).rejects.toMatchObject({ name: "RecordVerificationError", reason: "DID_RESOLUTION_FAILED" });
	});

	it("DID_RESOLUTION_FAILED when the document has no atproto PDS service entry", async () => {
		const resolver = new StubResolver(docWithoutPds());
		await expect(
			fetchAndVerifyExactRecord({
				uri: RELEASE_URI,
				cid: "bafkreiplaceholder00000000000000000000000000000000000000000",
				didDocumentResolver: resolver,
			}),
		).rejects.toMatchObject({ name: "RecordVerificationError", reason: "DID_RESOLUTION_FAILED" });
	});

	it("DID_RESOLUTION_FAILED when the document has no #atproto verification method", async () => {
		const resolver = new StubResolver(docWithoutVerificationMethod());
		await expect(
			fetchAndVerifyExactRecord({
				uri: RELEASE_URI,
				cid: "bafkreiplaceholder00000000000000000000000000000000000000000",
				didDocumentResolver: resolver,
			}),
		).rejects.toMatchObject({ name: "RecordVerificationError", reason: "DID_RESOLUTION_FAILED" });
	});
});

describe("fetchAndVerifyExactRecord: PDS fetch propagation", () => {
	function docWithPds(): DidDocument {
		return {
			id: TEST_DID,
			alsoKnownAs: [],
			verificationMethod: [
				{
					id: `${TEST_DID}#atproto`,
					type: "Multikey",
					controller: TEST_DID,
					// Arbitrary but well-formed P-256 Multikey; never reached
					// because the stubbed fetch below returns 404 before any
					// signature verification happens.
					publicKeyMultibase: "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ",
				},
			],
			service: [
				{
					id: "#atproto_pds",
					type: "AtprotoPersonalDataServer",
					serviceEndpoint: "https://pds.test.example",
				},
			],
		};
	}

	it("propagates PdsVerificationError(RECORD_NOT_FOUND) untouched on a 404", async () => {
		const resolver = new StubResolver(docWithPds());
		await expect(
			fetchAndVerifyExactRecord({
				uri: RELEASE_URI,
				cid: "bafkreiplaceholder00000000000000000000000000000000000000000",
				didDocumentResolver: resolver,
				fetch: () => Promise.resolve(new Response("", { status: 404 })),
			}),
		).rejects.toBeInstanceOf(PdsVerificationError);
		try {
			await fetchAndVerifyExactRecord({
				uri: RELEASE_URI,
				cid: "bafkreiplaceholder00000000000000000000000000000000000000000",
				didDocumentResolver: resolver,
				fetch: () => Promise.resolve(new Response("", { status: 404 })),
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(PdsVerificationError);
			expect((err as PdsVerificationError).reason).toBe("RECORD_NOT_FOUND");
		}
	});
});
