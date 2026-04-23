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
 *   - With `network:fetch:any` (no allowlist), requests targeting literal
 *     private IPs or known internal hostnames must still be rejected.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

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
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- vi.fn's generic signature doesn't line up with Workers' fetch type; cast to the injectable contract
	}) as unknown as FetchImpl;
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — capability enforcement", () => {
	it("rejects when neither network:fetch nor network:fetch:any is held", async () => {
		await expect(
			sandboxHttpFetch("https://a.example.com/", undefined, {
				capabilities: [],
				allowedHosts: ["a.example.com"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/network:fetch/);
	});

	it("allows when network:fetch is held and host is on the list", async () => {
		const res = await sandboxHttpFetch("https://a.example.com/", undefined, {
			capabilities: ["network:fetch"],
			allowedHosts: ["a.example.com"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});

	it("allows when network:fetch:any is held and skips the allowlist for public hosts", async () => {
		const res = await sandboxHttpFetch("https://a.example.com/", undefined, {
			capabilities: ["network:fetch:any"],
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
				capabilities: ["network:fetch"],
				allowedHosts: ["a.example.com"],
				fetchImpl: mockFetchSequence([redirectResponse("https://evil.example.com/"), okResponse()]),
			}),
		).rejects.toThrow(/not allowed|host/i);
	});

	it("follows a redirect to a host that IS on the allowlist", async () => {
		const res = await sandboxHttpFetch("https://a.example.com/", undefined, {
			capabilities: ["network:fetch"],
			allowedHosts: ["a.example.com", "b.example.com"],
			fetchImpl: mockFetchSequence([
				redirectResponse("https://b.example.com/next"),
				okResponse("from-b"),
			]),
		});
		expect(res.status).toBe(200);
		expect(res.text).toBe("from-b");
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
				capabilities: ["network:fetch"],
				allowedHosts: ["a.example.com"],
				fetchImpl,
			}),
		).rejects.toThrow(/too many redirects|redirect/i);
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
				capabilities: ["network:fetch"],
				allowedHosts: ["a.example.com"],
				fetchImpl,
			},
		);

		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- vi.Mock type hygiene
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
				capabilities: ["network:fetch"],
				allowedHosts: ["a.example.com", "b.example.com"],
				fetchImpl,
			},
		);

		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- vi.Mock type hygiene
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
				capabilities: ["network:fetch"],
				allowedHosts: ["a.example.com", "b.example.com"],
				fetchImpl,
			},
		);

		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- vi.Mock type hygiene
		const secondCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[1];
		const init = secondCall?.[1] as RequestInit | undefined;
		const headers = new Headers(init?.headers);
		expect(headers.get("cookie")).toBeNull();
		expect(headers.get("proxy-authorization")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// SSRF defence for network:fetch:any
// ---------------------------------------------------------------------------

describe("sandboxHttpFetch — SSRF defence with network:fetch:any", () => {
	it("rejects literal loopback IPv4", async () => {
		await expect(
			sandboxHttpFetch("http://127.0.0.1/", undefined, {
				capabilities: ["network:fetch:any"],
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
					capabilities: ["network:fetch:any"],
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
					capabilities: ["network:fetch:any"],
					allowedHosts: [],
					fetchImpl: mockFetchSequence([okResponse()]),
				}),
			).rejects.toThrow();
		}
	});

	it("rejects IPv6 loopback", async () => {
		await expect(
			sandboxHttpFetch("http://[::1]/", undefined, {
				capabilities: ["network:fetch:any"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("re-applies the SSRF check on redirects", async () => {
		// Public host redirects to a private IP — must be blocked.
		await expect(
			sandboxHttpFetch("https://public.example.com/", undefined, {
				capabilities: ["network:fetch:any"],
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
				capabilities: ["network:fetch:any"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects IPv4-mapped IPv6 metadata address in hex form", async () => {
		await expect(
			sandboxHttpFetch("http://[::ffff:a9fe:a9fe]/latest/meta-data/", undefined, {
				capabilities: ["network:fetch:any"],
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
					capabilities: ["network:fetch:any"],
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
	// A plugin with { capabilities: ["network:fetch"], allowedHosts: ["*"] }
	// gets full egress with zero SSRF protection unless we apply the literal
	// check on the restricted path too. The allowlist describes scope, not
	// safety.
	it("rejects literal private IPv4 even with allowedHosts=['*']", async () => {
		await expect(
			sandboxHttpFetch("http://127.0.0.1/", undefined, {
				capabilities: ["network:fetch"],
				allowedHosts: ["*"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects cloud-metadata IP even with allowedHosts=['*']", async () => {
		await expect(
			sandboxHttpFetch("http://169.254.169.254/", undefined, {
				capabilities: ["network:fetch"],
				allowedHosts: ["*"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects localhost even with allowedHosts=['*']", async () => {
		await expect(
			sandboxHttpFetch("http://localhost/", undefined, {
				capabilities: ["network:fetch"],
				allowedHosts: ["*"],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("still allows public hosts with allowedHosts=['*']", async () => {
		const res = await sandboxHttpFetch("https://api.example.com/", undefined, {
			capabilities: ["network:fetch"],
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
				capabilities: ["network:fetch:any"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/scheme/i);
	});

	it("rejects data: scheme", async () => {
		await expect(
			sandboxHttpFetch("data:text/plain,secret", undefined, {
				capabilities: ["network:fetch:any"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/scheme/i);
	});

	it("rejects ftp: scheme", async () => {
		await expect(
			sandboxHttpFetch("ftp://example.com/file", undefined, {
				capabilities: ["network:fetch:any"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow(/scheme/i);
	});

	it("accepts http: and https:", async () => {
		for (const url of ["http://a.example.com/", "https://a.example.com/"]) {
			const res = await sandboxHttpFetch(url, undefined, {
				capabilities: ["network:fetch"],
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
			capabilities: ["network:fetch"],
			allowedHosts: ["API.Example.COM"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});

	it("matches when the request uses a trailing dot FQDN", async () => {
		const res = await sandboxHttpFetch("https://api.example.com./", undefined, {
			capabilities: ["network:fetch"],
			allowedHosts: ["api.example.com"],
			fetchImpl: mockFetchSequence([okResponse()]),
		});
		expect(res.status).toBe(200);
	});

	it("matches wildcard patterns case-insensitively", async () => {
		const res = await sandboxHttpFetch("https://api.example.com/", undefined, {
			capabilities: ["network:fetch"],
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
				capabilities: ["network:fetch:any"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});

	it("rejects nested *.localhost subdomains", async () => {
		await expect(
			sandboxHttpFetch("http://admin.app.localhost/", undefined, {
				capabilities: ["network:fetch:any"],
				allowedHosts: [],
				fetchImpl: mockFetchSequence([okResponse()]),
			}),
		).rejects.toThrow();
	});
});
