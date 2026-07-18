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
import type { DnsResolver } from "emdash/security/ssrf";
import { beforeAll, describe, expect, it } from "vitest";

import { fetchAndVerifyRecord, isTransient, PdsVerificationError } from "../src/pds-verify.js";

const TEST_DID = "did:plc:test00000000000000000000";
const TEST_PDS = "https://pds.test.example";
const TEST_PDS_HOST = "pds.test.example";
/** A public, non-reserved address so the default resolver stub passes the
 * SSRF blocklist. Real production uses `cloudflareDohResolver`. */
const PUBLIC_IP = "93.184.216.34";

/** Default resolver stub: every hostname maps to one public address. Tests that
 * exercise the SSRF boundary pass their own. */
const publicResolver: DnsResolver = async () => [PUBLIC_IP];

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
	pds?: string;
	resolveHostname?: DnsResolver;
}) {
	return {
		pds: TEST_PDS,
		did: TEST_DID,
		collection: "com.emdashcms.experimental.package.profile",
		rkey: "demo",
		publicKey,
		resolveHostname: publicResolver,
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

describe("fetchAndVerifyRecord — SSRF egress hardening", () => {
	const rejectFetch: typeof fetch = () => {
		throw new Error("fetch must not be reached when the URL is blocked");
	};

	it("fails closed with PDS_ADDRESS_BLOCKED when no resolver is provided", async () => {
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: rejectFetch, resolveHostname: undefined })),
		);
		expect(err.reason).toBe("PDS_ADDRESS_BLOCKED");
	});

	it("rejects a non-HTTPS PDS endpoint with PDS_ADDRESS_BLOCKED", async () => {
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: rejectFetch, pds: "http://pds.test.example" })),
		);
		expect(err.reason).toBe("PDS_ADDRESS_BLOCKED");
	});

	it("maps an empty DNS answer to the transient PDS_NETWORK_ERROR", async () => {
		// An empty resolver answer (NXDOMAIN / NOERROR-NODATA / CNAME-only) is a
		// host mid-propagation, not a disallowed address — it must retry, not
		// dead-letter. A genuinely-gone host dead-letters via retry exhaustion.
		// Keyed on the shared helper's `Hostname resolved to no addresses` wording;
		// this breaks if that wording changes rather than silently mis-classifying.
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: rejectFetch, resolveHostname: async () => [] })),
		);
		expect(err.reason).toBe("PDS_NETWORK_ERROR");
		expect(isTransient(err.reason, err.status)).toBe(true);
	});

	it("maps a resolver infrastructure failure to the transient PDS_NETWORK_ERROR", async () => {
		// A throwing resolver models a DoH network error / SERVFAIL / timeout —
		// transient infrastructure, not a disallowed address. It must NOT dead-letter.
		// If the shared helper's `Could not resolve hostname:` wording ever changes,
		// this assertion breaks instead of silently mis-classifying as permanent.
		const throwingResolver: DnsResolver = () => Promise.reject(new Error("DoH 503"));
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: rejectFetch, resolveHostname: throwingResolver })),
		);
		expect(err.reason).toBe("PDS_NETWORK_ERROR");
		expect(isTransient(err.reason, err.status)).toBe(true);
	});

	it("rejects when the endpoint resolves to a private address", async () => {
		const err = await captureRejection(
			fetchAndVerifyRecord(
				buildOpts({ fetch: rejectFetch, resolveHostname: async () => ["10.0.0.5"] }),
			),
		);
		expect(err.reason).toBe("PDS_ADDRESS_BLOCKED");
	});

	it("re-validates a redirect target and blocks one resolving to a reserved address", async () => {
		// Initial host resolves public; the redirect target resolves to the
		// cloud-metadata address. The private target must never be fetched.
		const resolver: DnsResolver = async (host) =>
			host === TEST_PDS_HOST ? [PUBLIC_IP] : ["169.254.169.254"];
		let evilFetched = false;
		const redirectModes: RequestInit["redirect"][] = [];
		const fetchImpl: typeof fetch = (input, init) => {
			redirectModes.push(init?.redirect);
			const href =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (href.includes(TEST_PDS_HOST)) {
				return Promise.resolve(
					new Response(null, {
						status: 302,
						headers: { location: "https://metadata.evil.example/x" },
					}),
				);
			}
			evilFetched = true;
			return Promise.resolve(new Response(new Uint8Array([0]), { status: 200 }));
		};
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, resolveHostname: resolver })),
		);
		expect(err.reason).toBe("PDS_ADDRESS_BLOCKED");
		expect(evilFetched).toBe(false);
		// `redirect: "manual"` is load-bearing: it's what forces our own per-hop
		// re-validation instead of fetch auto-following unchecked.
		expect(redirectModes).toEqual(["manual"]);
	});

	it("follows a redirect to a public target under redirect:manual on every hop", async () => {
		// Both hosts resolve public; the redirect is followed to the second host,
		// which returns garbage bytes (verifyRecord then rejects). The point is
		// that each hop was issued with `redirect: "manual"`.
		const redirectModes: RequestInit["redirect"][] = [];
		const fetchImpl: typeof fetch = (input, init) => {
			redirectModes.push(init?.redirect);
			const href =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (href.includes(TEST_PDS_HOST)) {
				return Promise.resolve(
					new Response(null, {
						status: 302,
						headers: { location: "https://mirror.test.example/x" },
					}),
				);
			}
			return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
		};
		await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, resolveHostname: publicResolver })),
		);
		expect(redirectModes).toEqual(["manual", "manual"]);
	});

	it("rejects a malformed redirect Location with PDS_ADDRESS_BLOCKED", async () => {
		// `http://` has an empty authority — `new URL` throws. A hostile publisher
		// controls this header, so the parse failure must be a blocked redirect,
		// not an escaping UNEXPECTED_ERROR, and the next hop must not be fetched.
		let hops = 0;
		const fetchImpl: typeof fetch = () => {
			hops += 1;
			return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://" } }));
		};
		const err = await captureRejection(fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl })));
		expect(err.reason).toBe("PDS_ADDRESS_BLOCKED");
		expect(hops).toBe(1);
	});

	it("rejects with PDS_ADDRESS_BLOCKED when redirects exceed the hop limit", async () => {
		// Every hop redirects to a fresh public host. After MAX_PDS_REDIRECTS
		// followed hops the next redirect is refused (permanent — dead-letter).
		let hops = 0;
		const fetchImpl: typeof fetch = () => {
			hops += 1;
			return Promise.resolve(
				new Response(null, {
					status: 302,
					headers: { location: `https://hop-${hops}.test.example/x` },
				}),
			);
		};
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, resolveHostname: publicResolver })),
		);
		expect(err.reason).toBe("PDS_ADDRESS_BLOCKED");
		expect(err.message).toMatch(/exceeded 3 redirects/);
		// Initial hop + 3 followed redirects are fetched; the 4th is refused
		// before a fetch is issued.
		expect(hops).toBe(4);
	});

	it("bounds a slow-drip body by the wall-clock deadline", async () => {
		// One byte then silence; the read only unblocks when the deadline aborts
		// the fetch signal, which errors the stream.
		const fetchImpl: typeof fetch = (_input, init) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1]));
					init?.signal?.addEventListener("abort", () => {
						controller.error(new DOMException("aborted", "AbortError"));
					});
				},
			});
			return Promise.resolve(new Response(stream, { status: 200 }));
		};
		const err = await captureRejection(
			fetchAndVerifyRecord(buildOpts({ fetch: fetchImpl, timeoutMs: 30 })),
		);
		expect(err.reason).toBe("PDS_NETWORK_ERROR");
		expect(err.message).toMatch(/aborted after 30ms/);
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
