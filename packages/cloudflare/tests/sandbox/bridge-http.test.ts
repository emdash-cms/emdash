/**
 * Tests for sandboxHttpFetch — the bridge's outbound HTTP helper used by
 * sandboxed plugins.
 *
 * Two behaviours that need coverage:
 *   - Redirects must re-validate against allowedHosts at every hop. The
 *     native `fetch` follows 3xx responses automatically, so an allowed host
 *     that 302s to a blocked host would otherwise bypass the allowlist.
 *   - Credential headers (Authorization, Cookie, Proxy-Authorization) must
 *     be stripped on cross-origin hops so they don't leak to attacker
 *     destinations.
 *   - With `network:request:unrestricted` (no allowlist), requests targeting literal
 *     private IPs or known internal hostnames must still be rejected.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	PLUGIN_HTTP_MAX_REQUEST_BYTES,
	PLUGIN_HTTP_MAX_RESPONSE_BYTES,
} from "../../../core/src/plugins/http-wire.js";
import {
	bytesOverLimit,
	chunkedBytes,
	INVALID_PLUGIN_HTTP_BYTES,
	PLUGIN_HTTP_FORM_BYTES,
	PLUGIN_HTTP_FORM_CONTENT_TYPE,
	pluginHttpFormBody,
} from "../../../core/tests/fixtures/plugin-http.js";
import { sandboxHttpFetch } from "../../src/sandbox/bridge-http.js";

function okResponse(body = "ok"): Response {
	return new Response(body, { status: 200 });
}

function redirectResponse(location: string, status = 302): Response {
	return new Response(null, { status, headers: { Location: location } });
}

type FetchImpl = NonNullable<Parameters<typeof sandboxHttpFetch>[2]["fetchImpl"]>;

function mockFetchSequence(responses: Response[]): FetchImpl {
	const queue = [...responses];
	return vi.fn(async () => {
		const next = queue.shift();
		if (!next) throw new Error("fetch called more times than expected");
		return next;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- vi.fn's generic signature doesn't line up with Workers' fetch type; cast to the injectable contract
	}) as unknown as FetchImpl;
}

function initOfFetchCall(fetchImpl: FetchImpl, index: number): RequestInit | undefined {
	const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[index];
	return call?.[1] as RequestInit | undefined;
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — capability enforcement", () => {
	it("rejects when neither network:request nor network:request:unrestricted is held", async () => {
		await expect(
			sandboxHttpFetch("https://a.example.com/", undefined, {
				capabilities: [],
				allowedHosts: ["a.example.com"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/network:request/);
	});

	it("allows when network:request is held and host is on the list", async () => {
		const res = await sandboxHttpFetch("https://a.example.com/", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["a.example.com"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});

	it("allows when network:request:unrestricted is held and skips the allowlist for public hosts", async () => {
		const res = await sandboxHttpFetch("https://a.example.com/", undefined, {
			capabilities: ["network:request:unrestricted"],
			allowedHosts: [],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Host allowlist enforcement per redirect hop
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — redirect allowlist enforcement", () => {
	it("rejects a redirect to a host not on the allowlist", async () => {
		await expect(
			sandboxHttpFetch("https://a.example.com/", undefined, {
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com"],
				fetchImpl: mockFetchSequence([redirectResponse("https://evil.example.com/"), okResponse()]),
			}),
		).rejects.toThrow(/not allowed|host/i);
	});

	it("follows a redirect to a host that IS on the allowlist", async () => {
		const res = await sandboxHttpFetch("https://a.example.com/", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["a.example.com", "b.example.com"],
			fetchImpl: mockFetchSequence([
				redirectResponse("https://b.example.com/next"),
				okResponse("from-b"),
			]),
		});
		expect(res.status).toBe(200);
		expect(new TextDecoder().decode(res.body)).toBe("from-b");
	});

	it("rejects chains that exceed the redirect limit", async () => {
		// 6 redirects to the same allowed host — more than our max of 5
		const fetchImpl = mockFetchSequence([
			redirectResponse("https://a.example.com/1"),
			redirectResponse("https://a.example.com/2"),
			redirectResponse("https://a.example.com/3"),
			redirectResponse("https://a.example.com/4"),
			redirectResponse("https://a.example.com/5"),
			redirectResponse("https://a.example.com/6"),
			okResponse(),
		]);

		await expect(
			sandboxHttpFetch("https://a.example.com/", undefined, {
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com"],
				fetchImpl,
			}),
		).rejects.toThrow(/too many redirects|redirect/i);
	});
});

describe("sandboxHttpFetch — bounded binary transport", () => {
	it("preserves invalid UTF-8 bytes and response metadata", async () => {
		const response = new Response(
			chunkedBytes([
				INVALID_PLUGIN_HTTP_BYTES.subarray(0, 2),
				INVALID_PLUGIN_HTTP_BYTES.subarray(2),
			]),
			{
				status: 206,
				statusText: "Partial Content",
				headers: { "content-type": "application/octet-stream" },
			},
		);
		const result = await sandboxHttpFetch("https://a.example.com/file", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["a.example.com"],
			fetchImpl: mockFetchSequence([response]),
		});

		expect(result).toMatchObject({
			status: 206,
			statusText: "Partial Content",
			finalUrl: "https://a.example.com/file",
			redirected: false,
		});
		expect(result.headers).toContainEqual(["content-type", "application/octet-stream"]);
		expect(result.body).toEqual(INVALID_PLUGIN_HTTP_BYTES);
	});

	it("rejects a disallowed host before reading the request body", async () => {
		let bodyRead = false;
		const init = { method: "POST" } as RequestInit;
		Object.defineProperty(init, "body", {
			get() {
				bodyRead = true;
				return "secret";
			},
		});
		await expect(
			sandboxHttpFetch("https://blocked.example.com", init, {
				capabilities: ["network:request"],
				allowedHosts: ["api.example.com"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/host not allowed/i);
		expect(bodyRead).toBe(false);
	});

	it("rejects streamed requests after the decoded limit before dispatch", async () => {
		const fetchImpl = mockFetchSequence([okResponse()]);
		await expect(
			sandboxHttpFetch(
				"https://a.example.com/upload",
				{
					method: "POST",
					body: bytesOverLimit(PLUGIN_HTTP_MAX_REQUEST_BYTES),
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Node's fetch runtime requires duplex for streamed request bodies but lib.dom omits it
					duplex: "half",
				} as RequestInit,
				{
					capabilities: ["network:request"],
					allowedHosts: ["a.example.com"],
					fetchImpl,
				},
			),
		).rejects.toThrow(/request body exceeds the 8388608 byte limit/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects streamed responses after the decoded limit", async () => {
		await expect(
			sandboxHttpFetch("https://a.example.com/file", undefined, {
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com"],
				fetchImpl: mockFetchSequence([
					new Response(bytesOverLimit(PLUGIN_HTTP_MAX_RESPONSE_BYTES)),
				]),
			}),
		).rejects.toThrow(/response body exceeds the 8388608 byte limit/i);
	});

	it.each([
		{ status: 301, method: "POST", rewritten: true },
		{ status: 302, method: "POST", rewritten: true },
		{ status: 303, method: "PUT", rewritten: true },
		{ status: 307, method: "POST", rewritten: false },
		{ status: 308, method: "POST", rewritten: false },
	])(
		"applies Fetch method and body rules for a $status redirect",
		async ({ status, method, rewritten }) => {
			const fetchImpl = mockFetchSequence([
				redirectResponse("https://a.example.com/final", status),
				okResponse(),
			]);
			await sandboxHttpFetch(
				"https://a.example.com/start",
				{
					method,
					headers: {
						"content-type": "application/octet-stream",
						"content-language": "en",
						"content-length": String(INVALID_PLUGIN_HTTP_BYTES.byteLength),
						"transfer-encoding": "chunked",
						"x-request-id": "request-1",
					},
					body: INVALID_PLUGIN_HTTP_BYTES,
				},
				{
					capabilities: ["network:request"],
					allowedHosts: ["a.example.com"],
					fetchImpl,
				},
			);
			const redirectedInit = initOfFetchCall(fetchImpl, 1);
			expect(redirectedInit?.method).toBe(rewritten ? "GET" : method);
			if (rewritten) expect(redirectedInit?.body).toBeUndefined();
			else expect(redirectedInit?.body).toBeInstanceOf(ArrayBuffer);
			const headers = new Headers(redirectedInit?.headers);
			expect(headers.get("x-request-id")).toBe("request-1");
			expect(headers.get("content-type")).toBe(rewritten ? null : "application/octet-stream");
			expect(headers.get("content-language")).toBe(rewritten ? null : "en");
			expect(headers.get("content-length")).toBe(
				rewritten ? null : String(INVALID_PLUGIN_HTTP_BYTES.byteLength),
			);
			expect(headers.get("transfer-encoding")).toBe(rewritten ? null : "chunked");
		},
	);

	it("returns the redirect response when redirect mode is manual", async () => {
		const fetchImpl = mockFetchSequence([redirectResponse("https://a.example.com/final")]);
		const result = await sandboxHttpFetch(
			"https://a.example.com/start",
			{ redirect: "manual" },
			{
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com"],
				fetchImpl,
			},
		);
		expect(result).toMatchObject({
			status: 302,
			finalUrl: "https://a.example.com/start",
			redirected: false,
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("rejects the redirect when redirect mode is error", async () => {
		const fetchImpl = mockFetchSequence([redirectResponse("https://a.example.com/final")]);
		await expect(
			sandboxHttpFetch(
				"https://a.example.com/start",
				{ redirect: "error" },
				{
					capabilities: ["network:request"],
					allowedHosts: ["a.example.com"],
					fetchImpl,
				},
			),
		).rejects.toThrow(/redirect mode is "error"/i);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("does not follow a non-redirect 3xx response with Location", async () => {
		const fetchImpl = mockFetchSequence([
			new Response(null, {
				status: 304,
				headers: { location: "https://a.example.com/final" },
			}),
		]);
		const result = await sandboxHttpFetch("https://a.example.com/start", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["a.example.com"],
			fetchImpl,
		});
		expect(result).toMatchObject({ status: 304, redirected: false });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("encodes URLSearchParams with the portable request content type", async () => {
		const fetchImpl = mockFetchSequence([okResponse()]);
		await sandboxHttpFetch(
			"https://a.example.com/form",
			{ method: "POST", body: pluginHttpFormBody() },
			{
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com"],
				fetchImpl,
			},
		);
		const init = initOfFetchCall(fetchImpl, 0);
		expect(new Headers(init?.headers).get("content-type")).toBe(PLUGIN_HTTP_FORM_CONTENT_TYPE);
		expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(PLUGIN_HTTP_FORM_BYTES);
	});
});

// ---------------------------------------------------------------------------
// Credential header stripping on cross-origin redirects
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — credential header stripping", () => {
	it("preserves credentials on same-origin redirect", async () => {
		const fetchImpl = mockFetchSequence([
			redirectResponse("https://a.example.com/page2"),
			okResponse(),
		]);

		await sandboxHttpFetch(
			"https://a.example.com/",
			{
				headers: { Authorization: "Bearer secret-token" },
			},
			{
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com"],
				fetchImpl,
			},
		);

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- vi.Mock type hygiene
		const secondCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[1];
		const init = secondCall?.[1] as RequestInit | undefined;
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer secret-token");
	});

	it("strips Authorization on cross-origin redirect", async () => {
		const fetchImpl = mockFetchSequence([
			redirectResponse("https://b.example.com/after"),
			okResponse(),
		]);

		await sandboxHttpFetch(
			"https://a.example.com/",
			{
				headers: { Authorization: "Bearer secret-token" },
			},
			{
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com", "b.example.com"],
				fetchImpl,
			},
		);

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- vi.Mock type hygiene
		const secondCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[1];
		const init = secondCall?.[1] as RequestInit | undefined;
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBeNull();
	});

	it("strips Cookie and Proxy-Authorization on cross-origin redirect", async () => {
		const fetchImpl = mockFetchSequence([
			redirectResponse("https://b.example.com/after"),
			okResponse(),
		]);

		await sandboxHttpFetch(
			"https://a.example.com/",
			{
				headers: {
					Cookie: "session=abc",
					"Proxy-Authorization": "Basic creds",
				},
			},
			{
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com", "b.example.com"],
				fetchImpl,
			},
		);

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- vi.Mock type hygiene
		const secondCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[1];
		const init = secondCall?.[1] as RequestInit | undefined;
		const headers = new Headers(init?.headers);
		expect(headers.get("cookie")).toBeNull();
		expect(headers.get("proxy-authorization")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// SSRF defence for network:request:unrestricted
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — SSRF defence with network:request:unrestricted", () => {
	it("rejects literal loopback IPv4", async () => {
		await expect(
			sandboxHttpFetch("http://127.0.0.1/", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects literal private IPv4 ranges", async () => {
		for (const url of [
			"http://10.0.0.1/",
			"http://192.168.1.1/",
			"http://172.16.0.1/",
			"http://169.254.169.254/latest/meta-data/",
		]) {
			await expect(
				sandboxHttpFetch(url, undefined, {
					capabilities: ["network:request:unrestricted"],
					allowedHosts: [],
					fetchImpl: mockFetchSequence([okResponse()]),
				}),
			).rejects.toThrow();
		}
	});

	it("rejects localhost and metadata hostnames", async () => {
		for (const url of ["http://localhost/", "http://metadata.google.internal/"]) {
			await expect(
				sandboxHttpFetch(url, undefined, {
					capabilities: ["network:request:unrestricted"],
					allowedHosts: [],
					fetchImpl: mockFetchSequence([okResponse()]),
				}),
			).rejects.toThrow();
		}
	});

	it("rejects IPv6 loopback", async () => {
		await expect(
			sandboxHttpFetch("http://[::1]/", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("re-applies the SSRF check on redirects", async () => {
		// Public host redirects to a private IP — must be blocked.
		await expect(
			sandboxHttpFetch("https://public.example.com/", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([
					redirectResponse("http://169.254.169.254/latest/meta-data/"),
					okResponse(),
				]),
			}),
		).rejects.toThrow();
	});

	// The WHATWG URL parser normalises IPv4-mapped IPv6 to hex form:
	//   [::ffff:127.0.0.1]       -> [::ffff:7f00:1]
	//   [::ffff:169.254.169.254] -> [::ffff:a9fe:a9fe]
	// A literal-string check against "::ffff:127.0.0.1" never matches the
	// form the bridge actually sees. We must normalise the hex form back
	// to dotted-decimal before the range check.
	it("rejects IPv4-mapped IPv6 loopback in hex form", async () => {
		await expect(
			sandboxHttpFetch("http://[::ffff:7f00:1]/", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects IPv4-mapped IPv6 metadata address in hex form", async () => {
		await expect(
			sandboxHttpFetch("http://[::ffff:a9fe:a9fe]/latest/meta-data/", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects IPv4-mapped IPv6 private ranges in hex form", async () => {
		for (const url of [
			"http://[::ffff:a00:1]/", // 10.0.0.1
			"http://[::ffff:c0a8:1]/", // 192.168.0.1
			"http://[::ffff:ac10:1]/", // 172.16.0.1
		]) {
			await expect(
				sandboxHttpFetch(url, undefined, {
					capabilities: ["network:request:unrestricted"],
					allowedHosts: [],
					fetchImpl: mockFetchSequence([okResponse()]),
				}),
			).rejects.toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// SSRF defence applies even when the restricted path uses allowedHosts=["*"]
// ---------------------------------------------------------------------------

describe('sandboxHttpFetch — SSRF defence with allowedHosts=["*"]', () => {
	// A plugin with { capabilities: ["network:request"], allowedHosts: ["*"] }
	// gets full egress with zero SSRF protection unless we apply the literal
	// check on the restricted path too. The allowlist describes scope, not
	// safety.
	it("rejects literal private IPv4 even with allowedHosts=['*']", async () => {
		await expect(
			sandboxHttpFetch("http://127.0.0.1/", undefined, {
				capabilities: ["network:request"],
				allowedHosts: ["*"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects cloud-metadata IP even with allowedHosts=['*']", async () => {
		await expect(
			sandboxHttpFetch("http://169.254.169.254/", undefined, {
				capabilities: ["network:request"],
				allowedHosts: ["*"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects localhost even with allowedHosts=['*']", async () => {
		await expect(
			sandboxHttpFetch("http://localhost/", undefined, {
				capabilities: ["network:request"],
				allowedHosts: ["*"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("still allows public hosts with allowedHosts=['*']", async () => {
		const res = await sandboxHttpFetch("https://api.example.com/", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["*"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// URL scheme enforcement
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — scheme enforcement", () => {
	it("rejects file: scheme", async () => {
		await expect(
			sandboxHttpFetch("file:///etc/passwd", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/scheme/i);
	});

	it("rejects data: scheme", async () => {
		await expect(
			sandboxHttpFetch("data:text/plain,secret", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/scheme/i);
	});

	it("rejects ftp: scheme", async () => {
		await expect(
			sandboxHttpFetch("ftp://example.com/file", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/scheme/i);
	});

	it("accepts http: and https:", async () => {
		for (const url of ["http://a.example.com/", "https://a.example.com/"]) {
			const res = await sandboxHttpFetch(url, undefined, {
				capabilities: ["network:request"],
				allowedHosts: ["a.example.com"],
				fetchImpl: mockFetchSequence([okResponse()]),
			});
			expect(res.status).toBe(200);
		}
	});
});

// ---------------------------------------------------------------------------
// Allowlist normalisation — trailing dots and mixed case
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — allowlist normalisation", () => {
	it("matches when the manifest uses mixed case", async () => {
		const res = await sandboxHttpFetch("https://api.example.com/", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["API.Example.COM"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});

	it("matches when the request uses a trailing dot FQDN", async () => {
		const res = await sandboxHttpFetch("https://api.example.com./", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["api.example.com"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});

	it("matches wildcard patterns case-insensitively", async () => {
		const res = await sandboxHttpFetch("https://api.example.com/", undefined, {
			capabilities: ["network:request"],
			allowedHosts: ["*.Example.COM"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// *.localhost hostnames
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — *.localhost", () => {
	// RFC 6761 reserves .localhost for loopback. Subdomains of localhost
	// must be treated as internal too.
	it("rejects app.localhost", async () => {
		await expect(
			sandboxHttpFetch("http://app.localhost/", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects nested *.localhost subdomains", async () => {
		await expect(
			sandboxHttpFetch("http://admin.app.localhost/", undefined, {
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});
});
