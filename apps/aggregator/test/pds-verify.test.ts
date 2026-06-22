/**
 * pds-verify unit tests.
 *
 * Cover the HTTP / error-shaping logic with a stub `fetch`. The actual
 * verification handoff to `@atcute/repo`'s `verifyRecord` is NOT exercised
 * end-to-end anywhere in this suite — building a valid signed CAR by hand
 * would re-implement what `@atcute/repo` already tests internally, and the
 * consumer-level test path stubs verification via `ConsumerDeps.verify`
 * (the FakePublisher / MockPds fixture from `@emdash-cms/atproto-test-utils`
 * can't load inside `@cloudflare/vitest-pool-workers` due to a transitive
 * `@atproto/lex-data` incompatibility; see records-consumer test header).
 *
 * What we DO test here is the surface every reason code can be reached
 * through, plus the `isTransient` policy mapping the consumer relies on.
 */

import { P256PublicKey, P256PrivateKeyExportable } from "@atcute/crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { fetchAndVerifyRecord, isTransient, PdsVerificationError } from "../src/pds-verify.js";

const TEST_DID = "did:plc:test00000000000000000000";
const TEST_PDS = "https://pds.test.example";

let publicKey: P256PublicKey;

beforeAll(async () => {
	const kp = await P256PrivateKeyExportable.createKeypair();
	const raw = await kp.exportPublicKey("raw");
	publicKey = await P256PublicKey.importRaw(raw);
});

async function captureRejection<T>(promise: Promise<T>): Promise<PdsVerificationError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof PdsVerificationError) return err;
		throw err;
	}
	throw new Error("expected promise to reject with PdsVerificationError");
}

function buildOpts(overrides: {
	fetch: typeof fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
}) {
	return {
		pds: TEST_PDS,
		did: TEST_DID,
		collection: "com.emdashcms.experimental.package.profile",
		rkey: "demo",
		publicKey,
		...overrides,
	};
}

describe("fetchAndVerifyRecord — HTTP path", () => {
	it("builds the canonical sync.getRecord URL with did/collection/rkey", async () => {
		let observedUrl: string | undefined;
		const fetchImpl: typeof fetch = async (input) => {
			observedUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return new Response(new Uint8Array([0]), { status: 200 });
		};
		await fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })).catch(() => {
			/* verifyRecord rejects on the dummy bytes — we only care about the URL */
		});
		expect(observedUrl).toBe(
			`${TEST_PDS}/xrpc/com.atproto.sync.getRecord?did=${encodeURIComponent(TEST_DID)}&collection=com.emdashcms.experimental.package.profile&rkey=demo`,
		);
	});

	it("maps a network error to PDS_NETWORK_ERROR", async () => {
		const fetchImpl: typeof fetch = () => Promise.reject(new TypeError("connection refused"));
		await expect(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl }))).rejects.toMatchObject({
			name: "PdsVerificationError",
			reason: "PDS_NETWORK_ERROR",
		});
	});

	it("maps an aborted fetch (timeout) to PDS_NETWORK_ERROR with the timeout in the message", async () => {
		const fetchImpl: typeof fetch = (_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new DOMException("aborted", "AbortError");
					reject(err);
				});
			});
		};
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, timeoutMs: 25 })),
		);
		expect(err.reason).toBe("PDS_NETWORK_ERROR");
		expect(err.message).toMatch(/aborted after 25ms/);
	});

	it("maps a 404 to RECORD_NOT_FOUND with status", async () => {
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response("", { status: 404 }));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("RECORD_NOT_FOUND");
		expect(err.status).toBe(404);
	});

	it("maps a 500 to PDS_HTTP_ERROR with status", async () => {
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response("", { status: 503 }));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("PDS_HTTP_ERROR");
		expect(err.status).toBe(503);
	});

	it("maps a non-404 4xx to PDS_HTTP_ERROR with status", async () => {
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response("", { status: 401 }));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("PDS_HTTP_ERROR");
		expect(err.status).toBe(401);
	});

	it("rejects responses larger than maxResponseBytes with RESPONSE_TOO_LARGE", async () => {
		const big = new Uint8Array(64);
		big.fill(0xff);
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response(big, { status: 200 }));
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, maxResponseBytes: 16 })),
		);
		expect(err.reason).toBe("RESPONSE_TOO_LARGE");
	});

	it("rejects a null body with INVALID_PROOF", async () => {
		const fetchImpl: typeof fetch = () => {
			// Construct a Response with a null body. The Response constructor
			// allows null for HEAD-style responses; we never get null in
			// practice but the guard is defensive.
			return Promise.resolve(new Response(null, { status: 200 }));
		};
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("INVALID_PROOF");
	});

	it("hands successful body bytes to verifyRecord (which rejects malformed input as INVALID_PROOF)", async () => {
		// Random bytes are guaranteed not to parse as a valid CAR. The point
		// of the test is that we got past HTTP and INTO verifyRecord — and
		// that verifyRecord's rejection is wrapped as INVALID_PROOF.
		const garbage = new Uint8Array([1, 2, 3, 4, 5]);
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response(garbage, { status: 200 }));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("INVALID_PROOF");
		expect(err.cause).toBeDefined();
	});
});

describe("isTransient policy", () => {
	it("network errors retry", () => {
		expect(isTransient("PDS_NETWORK_ERROR", undefined)).toBe(true);
	});
	it("HTTP 5xx retries", () => {
		expect(isTransient("PDS_HTTP_ERROR", 500)).toBe(true);
		expect(isTransient("PDS_HTTP_ERROR", 503)).toBe(true);
	});
	it("HTTP 4xx is permanent", () => {
		expect(isTransient("PDS_HTTP_ERROR", 401)).toBe(false);
		expect(isTransient("PDS_HTTP_ERROR", 400)).toBe(false);
	});
	it("missing status on PDS_HTTP_ERROR is treated as permanent", () => {
		// Defensive: PDS_HTTP_ERROR is always raised with a status, but the
		// policy must not blow up if a future code path drops it.
		expect(isTransient("PDS_HTTP_ERROR", undefined)).toBe(false);
	});
	it("404, oversized response, and invalid proof are permanent", () => {
		expect(isTransient("RECORD_NOT_FOUND", 404)).toBe(false);
		expect(isTransient("RESPONSE_TOO_LARGE", undefined)).toBe(false);
		expect(isTransient("INVALID_PROOF", undefined)).toBe(false);
	});
});
