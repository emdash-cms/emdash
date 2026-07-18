/**
 * pds-verify SSRF-egress + HTTP-shaping unit tests.
 *
 * The PDS endpoint (and any redirect it serves) is publisher-controlled, so the
 * CAR fetch is routed through the same SSRF egress guard artifact acquisition
 * uses: HTTPS-only, DoH resolution with private/reserved-IP rejection, and
 * per-hop redirect re-resolution. These tests inject a fake `fetch` and a fake
 * `resolveHostname` so no real network or DoH round-trip happens.
 *
 * The crypto handoff to `@atcute/repo`'s `verifyRecord` is not exercised
 * end-to-end (a valid signed CAR would re-implement what the library already
 * tests, and its fixture can't load inside `@cloudflare/vitest-pool-workers`);
 * reaching `verifyRecord` at all is proof the request passed the egress guard.
 */

import { P256PrivateKeyExportable, P256PublicKey } from "@atcute/crypto";
import type { DnsResolver } from "emdash/security/ssrf";
import { beforeAll, describe, expect, it } from "vitest";

import { fetchAndVerifyRecord, PdsVerificationError } from "../src/pds-verify.js";

const TEST_DID = "did:plc:test00000000000000000000";
const TEST_PDS = "https://pds.test.example";
const PUBLIC_IP = "93.184.216.34";

let publicKey: P256PublicKey;

beforeAll(async () => {
	const kp = await P256PrivateKeyExportable.createKeypair();
	publicKey = await P256PublicKey.importRaw(await kp.exportPublicKey("raw"));
});

const resolvePublic: DnsResolver = () => Promise.resolve([PUBLIC_IP]);

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
	pds?: string;
	resolveHostname?: DnsResolver;
	timeoutMs?: number;
	maxResponseBytes?: number;
}) {
	return {
		pds: overrides.pds ?? TEST_PDS,
		did: TEST_DID,
		collection: "com.emdashcms.experimental.package.profile",
		rkey: "demo",
		publicKey,
		resolveHostname: overrides.resolveHostname ?? resolvePublic,
		fetch: overrides.fetch,
		...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
		...(overrides.maxResponseBytes !== undefined
			? { maxResponseBytes: overrides.maxResponseBytes }
			: {}),
	};
}

function redirectTo(location: string, status = 302): Response {
	return new Response(null, { status, headers: { location } });
}

describe("fetchAndVerifyRecord — SSRF egress guard", () => {
	it("rejects a non-HTTPS PDS with PDS_HOST_BLOCKED before fetching", async () => {
		let called = false;
		const fetchImpl: typeof fetch = () => {
			called = true;
			return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
		};
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, pds: "http://pds.test.example" })),
		);
		expect(err.reason).toBe("PDS_HOST_BLOCKED");
		expect(called).toBe(false);
	});

	it("rejects a PDS whose host resolves to a private address", async () => {
		let called = false;
		const fetchImpl: typeof fetch = () => {
			called = true;
			return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
		};
		const err = await captureRejection(
			fetchAndVerifyRecord(
				buildOpts({ fetch: fetchImpl, resolveHostname: () => Promise.resolve(["10.0.0.1"]) }),
			),
		);
		expect(err.reason).toBe("PDS_HOST_BLOCKED");
		expect(called).toBe(false);
	});

	it("rejects when the resolver returns no addresses (fails closed)", async () => {
		const fetchImpl: typeof fetch = () =>
			Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
		const err = await captureRejection(
			fetchAndVerifyRecord(
				buildOpts({ fetch: fetchImpl, resolveHostname: () => Promise.resolve([]) }),
			),
		);
		expect(err.reason).toBe("PDS_HOST_BLOCKED");
	});

	it("rejects a redirect that points at a private address (per-hop re-resolution)", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = () => {
			calls += 1;
			return Promise.resolve(redirectTo("https://internal.example/xrpc"));
		};
		const resolveByHost: DnsResolver = (hostname) =>
			Promise.resolve(hostname === "internal.example" ? ["10.0.0.1"] : [PUBLIC_IP]);
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, resolveHostname: resolveByHost })),
		);
		expect(err.reason).toBe("PDS_HOST_BLOCKED");
		// Only the first hop was fetched; the private redirect target is blocked
		// before its request is made.
		expect(calls).toBe(1);
	});

	it("rejects a redirect that downgrades to a non-HTTPS scheme", async () => {
		const fetchImpl: typeof fetch = () =>
			Promise.resolve(redirectTo("http://pds.test.example/xrpc"));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("PDS_HOST_BLOCKED");
	});

	it("stops after the redirect limit with PDS_HTTP_ERROR", async () => {
		const fetchImpl: typeof fetch = () =>
			Promise.resolve(redirectTo("https://loop.test.example/next"));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("PDS_HTTP_ERROR");
	});
});

describe("fetchAndVerifyRecord — the guard permits public hosts", () => {
	it("follows an allowed HTTPS redirect and re-resolves each hop", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = () => {
			calls += 1;
			if (calls === 1) return Promise.resolve(redirectTo("https://mirror.test.example/xrpc"));
			return Promise.resolve(new Response("", { status: 404 }));
		};
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		// Reaching the 404 proves the redirect was followed and both hops passed
		// the egress guard.
		expect(err.reason).toBe("RECORD_NOT_FOUND");
		expect(err.status).toBe(404);
		expect(calls).toBe(2);
	});

	it("maps a 404 to RECORD_NOT_FOUND with status", async () => {
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response("", { status: 404 }));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("RECORD_NOT_FOUND");
		expect(err.status).toBe(404);
	});

	it("maps a 5xx to PDS_HTTP_ERROR with status", async () => {
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response("", { status: 503 }));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("PDS_HTTP_ERROR");
		expect(err.status).toBe(503);
	});

	it("surfaces a network error from an allowed host as PDS_NETWORK_ERROR", async () => {
		const fetchImpl: typeof fetch = () => Promise.reject(new TypeError("connection refused"));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("PDS_NETWORK_ERROR");
	});

	it("bounds a slow-drip body read by the timeout budget", async () => {
		// The stream yields one chunk then stalls forever: the next read never
		// resolves, so only the per-read time budget can end it.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
			},
		});
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response(stream, { status: 200 }));
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, timeoutMs: 40 })),
		);
		expect(err.reason).toBe("PDS_NETWORK_ERROR");
		expect(err.message).toMatch(/exceeded 40ms/);
	});

	it("hands successful body bytes to verifyRecord (INVALID_PROOF on garbage)", async () => {
		const garbage = new Uint8Array([1, 2, 3, 4, 5]);
		const fetchImpl: typeof fetch = () => Promise.resolve(new Response(garbage, { status: 200 }));
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("INVALID_PROOF");
		expect(err.cause).toBeDefined();
	});
});
