/**
 * Tests that plugin HTTP functions strip credential headers on cross-origin redirects.
 *
 * Both createHttpAccess and createUnrestrictedHttpAccess manually follow redirects.
 * When a redirect crosses origins, Authorization/Cookie/Proxy-Authorization headers
 * must be stripped to prevent credential leakage to untrusted hosts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setDefaultDnsResolver } from "../../../src/import/ssrf.js";
import { createHttpAccess, createUnrestrictedHttpAccess } from "../../../src/plugins/context.js";
import {
	PLUGIN_HTTP_MAX_REQUEST_BYTES,
	PLUGIN_HTTP_MAX_RESPONSE_BYTES,
	bufferPluginHttpRequest,
} from "../../../src/plugins/http-wire.js";
import {
	bytesOverLimit,
	chunkedBytes,
	INVALID_PLUGIN_HTTP_BYTES,
	PLUGIN_HTTP_FORM_BYTES,
	PLUGIN_HTTP_FORM_CONTENT_TYPE,
	pluginHttpFormBody,
} from "../../fixtures/plugin-http.js";

// Intercept globalThis.fetch so we can simulate redirect chains
const mockFetch = vi.fn<typeof globalThis.fetch>();
vi.stubGlobal("fetch", mockFetch);

// Bypass DoH so the fetch mock only sees the calls these tests model.
// Returns a fixed public IP so resolveAndValidateExternalUrl passes.
const STUB_RESOLVER = async () => ["93.184.216.34"];
let previousResolver: ReturnType<typeof setDefaultDnsResolver> | undefined;

beforeAll(() => {
	previousResolver = setDefaultDnsResolver(STUB_RESOLVER);
});

afterAll(() => {
	setDefaultDnsResolver(previousResolver ?? null);
});

afterEach(() => {
	mockFetch.mockReset();
});

/** Build a minimal redirect response */
function redirectResponse(location: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: { Location: location },
	});
}

/** Build a 200 response */
function okResponse(body = "ok"): Response {
	return new Response(body, { status: 200 });
}

/** Extract the headers passed to the Nth fetch call */
function headersOfCall(callIndex: number): Headers {
	const init = mockFetch.mock.calls[callIndex]?.[1] as RequestInit | undefined;
	return new Headers(init?.headers);
}

// =============================================================================
// createHttpAccess – host-restricted
// =============================================================================

describe("createHttpAccess host allowlist matching", () => {
	const pluginId = "test-plugin";

	it('allows any hostname when allowedHosts contains standalone "*"', async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*"]);
		await expect(http.fetch("https://api.example.com/v1")).resolves.toBeInstanceOf(Response);
		await expect(http.fetch("https://random.host.io/path")).resolves.toBeInstanceOf(Response);
	});

	it('allows requests when "*" is mixed with explicit hosts', async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*", "api.example.com"]);
		await expect(http.fetch("https://another.example.net/ok")).resolves.toBeInstanceOf(Response);
	});

	it('still supports "*.domain" wildcard matching', async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*.example.com"]);
		await expect(http.fetch("https://api.example.com/v1")).resolves.toBeInstanceOf(Response);
		await expect(http.fetch("https://evil.com")).rejects.toThrow(
			'is not allowed to fetch from host "evil.com"',
		);
	});

	it.each([
		{
			caseName: "mixed-case manifest hosts",
			url: "https://api.example.com/v1",
			allowedHosts: ["API.Example.COM"],
		},
		{
			caseName: "trailing-dot request hosts",
			url: "https://api.example.com.../v1",
			allowedHosts: ["api.example.com"],
		},
		{
			caseName: "mixed-case wildcard hosts",
			url: "https://cdn.example.com/v1",
			allowedHosts: ["*.Example.COM"],
		},
	])("normalizes $caseName", async ({ url, allowedHosts }) => {
		mockFetch.mockResolvedValue(okResponse());
		const http = createHttpAccess(pluginId, allowedHosts);
		await expect(http.fetch(url)).resolves.toBeInstanceOf(Response);
	});
});

describe("createHttpAccess external target validation", () => {
	const pluginId = "test-plugin";

	it("rejects non-HTTP schemes before dispatch", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*"]);
		await expect(http.fetch("file:///etc/hosts")).rejects.toThrow("Scheme 'file:' is not allowed");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("reports malformed URLs without dispatch", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*"]);
		await expect(http.fetch("not a URL")).rejects.toThrow(
			'blocked fetch to "invalid URL": Invalid URL',
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects disallowed hosts without resolving them", async () => {
		const resolver = vi.fn(async () => ["93.184.216.34"]);
		const previous = setDefaultDnsResolver(resolver);
		mockFetch.mockResolvedValue(okResponse());

		try {
			const http = createHttpAccess(pluginId, ["api.example.com"]);
			await expect(http.fetch("https://other.example.com/internal")).rejects.toThrow(
				'is not allowed to fetch from host "other.example.com"',
			);
			expect(resolver).not.toHaveBeenCalled();
			expect(mockFetch).not.toHaveBeenCalled();
		} finally {
			setDefaultDnsResolver(previous);
		}
	});

	it("rejects private IP literals before dispatch", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["*"]);
		await expect(http.fetch("http://127.0.0.1/internal")).rejects.toThrow(
			"URLs targeting non-public IP addresses are not allowed",
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it.each(["http://[::]/internal", "http://100.100.100.200/internal"])(
		"rejects non-public target %s before dispatch",
		async (url) => {
			mockFetch.mockResolvedValue(okResponse());

			const http = createHttpAccess(pluginId, ["*"]);
			await expect(http.fetch(url)).rejects.toThrow(
				"URLs targeting non-public IP addresses are not allowed",
			);
			expect(mockFetch).not.toHaveBeenCalled();
		},
	);

	it("rejects internal hostnames before dispatch", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createHttpAccess(pluginId, ["localhost"]);
		await expect(http.fetch("http://localhost/internal")).rejects.toThrow(
			"URLs targeting internal hosts are not allowed",
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects allowed hosts that resolve to private addresses before dispatch", async () => {
		const previous = setDefaultDnsResolver(async () => ["10.0.0.1"]);
		mockFetch.mockResolvedValue(okResponse());

		try {
			const http = createHttpAccess(pluginId, ["api.example.com"]);
			await expect(http.fetch("https://api.example.com/internal")).rejects.toThrow(
				"Hostname resolves to a non-public IP address",
			);
			expect(mockFetch).not.toHaveBeenCalled();
		} finally {
			setDefaultDnsResolver(previous);
		}
	});

	it("validates redirect destinations before dispatch", async () => {
		const previous = setDefaultDnsResolver(async (hostname) =>
			hostname === "api.example.com" ? ["93.184.216.34"] : ["10.0.0.1"],
		);
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://redirect.example.com/internal"))
			.mockResolvedValueOnce(okResponse());

		try {
			const http = createHttpAccess(pluginId, ["api.example.com", "redirect.example.com"]);
			await expect(http.fetch("https://api.example.com/start")).rejects.toThrow(
				"Hostname resolves to a non-public IP address",
			);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		} finally {
			setDefaultDnsResolver(previous);
		}
	});
});

describe("createHttpAccess credential stripping", () => {
	const pluginId = "test-plugin";
	const allowedHosts = ["a.example.com", "b.example.com"];

	it("preserves credentials on same-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://a.example.com/page2"))
			.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess(pluginId, allowedHosts);
		await http.fetch("https://a.example.com/page1", {
			headers: { Authorization: "Bearer secret", Cookie: "session=abc" },
		});

		// Second call should still have credentials (same origin)
		const h = headersOfCall(1);
		expect(h.get("authorization")).toBe("Bearer secret");
		expect(h.get("cookie")).toBe("session=abc");
	});

	it("strips credentials on cross-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://b.example.com/landing"))
			.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess(pluginId, allowedHosts);
		await http.fetch("https://a.example.com/start", {
			headers: {
				Authorization: "Bearer secret",
				Cookie: "session=abc",
				"Proxy-Authorization": "Basic creds",
				"X-Custom": "keep-me",
			},
		});

		const h = headersOfCall(1);
		expect(h.get("authorization")).toBeNull();
		expect(h.get("cookie")).toBeNull();
		expect(h.get("proxy-authorization")).toBeNull();
		// Non-credential headers survive
		expect(h.get("x-custom")).toBe("keep-me");
	});

	it("strips credentials only once even with multiple same-origin hops after cross-origin", async () => {
		// a.example.com -> b.example.com -> b.example.com/final
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://b.example.com/step1"))
			.mockResolvedValueOnce(redirectResponse("https://b.example.com/step2"))
			.mockResolvedValueOnce(okResponse());

		const http = createHttpAccess(pluginId, allowedHosts);
		await http.fetch("https://a.example.com/start", {
			headers: { Authorization: "Bearer secret" },
		});

		// Call 0: original (has auth)
		expect(headersOfCall(0).get("authorization")).toBe("Bearer secret");
		// Call 1: after cross-origin hop (stripped)
		expect(headersOfCall(1).get("authorization")).toBeNull();
		// Call 2: same-origin hop on b (still stripped -- not re-added)
		expect(headersOfCall(2).get("authorization")).toBeNull();
	});
});

describe("createHttpAccess buffered bodies", () => {
	const pluginId = "binary-plugin";

	it("preserves arbitrary response bytes and complete buffered Response behavior", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				chunkedBytes([
					INVALID_PLUGIN_HTTP_BYTES.subarray(0, 3),
					INVALID_PLUGIN_HTTP_BYTES.subarray(3),
				]),
				{
					status: 206,
					statusText: "Partial Content",
					headers: [["content-type", "application/octet-stream"]],
				},
			),
		);

		const response = await createHttpAccess(pluginId, ["api.example.com"]).fetch(
			"https://api.example.com/binary",
		);
		const clone = response.clone();
		const blobClone = response.clone();
		expect(response.status).toBe(206);
		expect(response.statusText).toBe("Partial Content");
		expect(response.url).toBe("https://api.example.com/binary");
		expect(response.redirected).toBe(false);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(INVALID_PLUGIN_HTTP_BYTES);
		expect(new Uint8Array(await clone.arrayBuffer())).toEqual(INVALID_PLUGIN_HTTP_BYTES);
		const blob = await blobClone.blob();
		expect(blob.type).toBe("application/octet-stream");
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(INVALID_PLUGIN_HTTP_BYTES);
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
			createHttpAccess(pluginId, ["api.example.com"]).fetch("https://blocked.example.com", init),
		).rejects.toThrow(/not allowed/i);
		expect(bodyRead).toBe(false);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("marks a manually followed response as redirected and preserves the final URL in clones", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://b.example.com/final"))
			.mockResolvedValueOnce(okResponse("done"));

		const response = await createHttpAccess(pluginId, ["a.example.com", "b.example.com"]).fetch(
			"https://a.example.com/start",
		);
		expect(response.url).toBe("https://b.example.com/final");
		expect(response.redirected).toBe(true);
		expect(response.clone().url).toBe("https://b.example.com/final");
	});

	it("rejects a streamed request after the decoded byte limit before dispatch", async () => {
		const http = createHttpAccess(pluginId, ["api.example.com"]);
		await expect(
			http.fetch("https://api.example.com/upload", {
				method: "POST",
				body: bytesOverLimit(PLUGIN_HTTP_MAX_REQUEST_BYTES),
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Node's fetch runtime requires duplex for streamed request bodies but lib.dom omits it
				duplex: "half",
			} as RequestInit),
		).rejects.toThrow(/request body exceeds the 8388608 byte limit/i);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("removes duplex after buffering a streamed request body", async () => {
		const init = {
			method: "POST",
			body: chunkedBytes([new Uint8Array([0, 255, 128, 10])]),
			duplex: "half",
		} as RequestInit & { duplex: "half" };

		const buffered = await bufferPluginHttpRequest(init);
		expect(buffered).not.toHaveProperty("duplex");
		expect(new Uint8Array(buffered?.body as ArrayBuffer)).toEqual(
			new Uint8Array([0, 255, 128, 10]),
		);
	});

	it("rejects a streamed response as soon as the decoded byte limit is crossed", async () => {
		mockFetch.mockResolvedValue(
			new Response(bytesOverLimit(PLUGIN_HTTP_MAX_RESPONSE_BYTES), { status: 200 }),
		);

		const http = createHttpAccess(pluginId, ["api.example.com"]);
		await expect(http.fetch("https://api.example.com/download")).rejects.toThrow(
			/response body exceeds the 8388608 byte limit/i,
		);
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
			mockFetch
				.mockResolvedValueOnce(redirectResponse("https://api.example.com/final", status))
				.mockResolvedValueOnce(okResponse());

			await createHttpAccess(pluginId, ["api.example.com"]).fetch("https://api.example.com/start", {
				method,
				headers: {
					"content-type": "application/octet-stream",
					"content-language": "en",
					"content-length": String(INVALID_PLUGIN_HTTP_BYTES.byteLength),
					"transfer-encoding": "chunked",
					"x-request-id": "request-1",
				},
				body: INVALID_PLUGIN_HTTP_BYTES,
			});
			const redirectedInit = mockFetch.mock.calls[1]?.[1];
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
		mockFetch.mockResolvedValueOnce(redirectResponse("https://api.example.com/final"));
		const response = await createHttpAccess(pluginId, ["api.example.com"]).fetch(
			"https://api.example.com/start",
			{ redirect: "manual" },
		);
		expect(response.status).toBe(302);
		expect(response.url).toBe("https://api.example.com/start");
		expect(response.redirected).toBe(false);
		expect(response.headers.get("location")).toBe("https://api.example.com/final");
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("rejects the redirect when redirect mode is error", async () => {
		mockFetch.mockResolvedValueOnce(redirectResponse("https://api.example.com/final"));
		await expect(
			createHttpAccess(pluginId, ["api.example.com"]).fetch("https://api.example.com/start", {
				redirect: "error",
			}),
		).rejects.toThrow(/redirect mode is "error"/i);
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("does not follow a non-redirect 3xx response with Location", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(null, {
				status: 304,
				headers: { location: "https://api.example.com/final" },
			}),
		);
		const response = await createHttpAccess(pluginId, ["api.example.com"]).fetch(
			"https://api.example.com/start",
		);
		expect(response.status).toBe(304);
		expect(response.redirected).toBe(false);
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("encodes URLSearchParams with the portable request content type", async () => {
		mockFetch.mockResolvedValue(okResponse());
		await createHttpAccess(pluginId, ["api.example.com"]).fetch("https://api.example.com/form", {
			method: "POST",
			body: pluginHttpFormBody(),
		});
		const init = mockFetch.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).get("content-type")).toBe(PLUGIN_HTTP_FORM_CONTENT_TYPE);
		expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(PLUGIN_HTTP_FORM_BYTES);
	});
});

// =============================================================================
// createUnrestrictedHttpAccess – SSRF-protected but no host list
// =============================================================================

describe("createUnrestrictedHttpAccess credential stripping", () => {
	const pluginId = "unrestricted-plugin";

	it("reports malformed URLs without dispatch", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const http = createUnrestrictedHttpAccess(pluginId);
		await expect(http.fetch("not a URL")).rejects.toThrow(
			'blocked fetch to "invalid URL": Invalid URL',
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("preserves credentials on same-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://api.example.com/v2"))
			.mockResolvedValueOnce(okResponse());

		const http = createUnrestrictedHttpAccess(pluginId);
		await http.fetch("https://api.example.com/v1", {
			headers: { Authorization: "Bearer token" },
		});

		expect(headersOfCall(1).get("authorization")).toBe("Bearer token");
	});

	it("strips credentials on cross-origin redirect", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://evil.example.com/steal"))
			.mockResolvedValueOnce(okResponse());

		const http = createUnrestrictedHttpAccess(pluginId);
		await http.fetch("https://api.example.com/start", {
			headers: {
				Authorization: "Bearer token",
				Cookie: "session=xyz",
				"Proxy-Authorization": "Basic pw",
				Accept: "application/json",
			},
		});

		const h = headersOfCall(1);
		expect(h.get("authorization")).toBeNull();
		expect(h.get("cookie")).toBeNull();
		expect(h.get("proxy-authorization")).toBeNull();
		expect(h.get("accept")).toBe("application/json");
	});

	it("handles redirect with no init gracefully", async () => {
		mockFetch
			.mockResolvedValueOnce(redirectResponse("https://other.example.com/"))
			.mockResolvedValueOnce(okResponse());

		const http = createUnrestrictedHttpAccess(pluginId);
		// No init at all -- should not throw
		await http.fetch("https://api.example.com/bare");

		expect(headersOfCall(1).get("authorization")).toBeNull();
	});
});
