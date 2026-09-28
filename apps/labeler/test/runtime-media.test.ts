import { describe, expect, it, vi } from "vitest";

import {
	createTrustedOriginServiceBindingTransport,
	parsePinnedHttpResponse,
} from "../src/assessment/runtime-media.js";

describe("trusted-origin service binding transport", () => {
	const input = (url: string) => ({
		url,
		allowedAddresses: ["104.16.0.1"],
		headers: { accept: "image/*" },
		redirect: "manual" as const,
		signal: new AbortController().signal,
		deadline: Date.now() + 10_000,
	});

	it("uses the service binding only for the exact trusted origin", async () => {
		const bindingFetch = vi.fn(async () => new Response("trusted"));
		const fallbackFetch = vi.fn(async () => ({
			response: new Response("fallback"),
			connectedAddress: "104.16.0.1",
		}));
		const transport = createTrustedOriginServiceBindingTransport(
			"https://cdn.em-da.sh",
			{ fetch: bindingFetch } as unknown as Fetcher,
			{ fetch: fallbackFetch },
		);

		const trusted = await transport.fetch(input("https://cdn.em-da.sh/r/did:plc:test/record"));
		expect(await trusted.response.text()).toBe("trusted");
		expect(trusted.connectedAddress).toBeNull();
		expect(bindingFetch).toHaveBeenCalledOnce();
		expect(fallbackFetch).not.toHaveBeenCalled();

		const external = await transport.fetch(input("https://media.example/image.png"));
		expect(await external.response.text()).toBe("fallback");
		expect(fallbackFetch).toHaveBeenCalledOnce();
	});

	it("preserves manual redirects for the guarded acquisition loop", async () => {
		const bindingFetch = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://media.example/image.png" },
				}),
		);
		const fallbackFetch = vi.fn(async () => ({
			response: new Response("external"),
			connectedAddress: "104.16.0.1",
		}));
		const transport = createTrustedOriginServiceBindingTransport(
			"https://cdn.em-da.sh",
			{ fetch: bindingFetch } as unknown as Fetcher,
			{ fetch: fallbackFetch },
		);

		const redirect = await transport.fetch(input("https://cdn.em-da.sh/r/revision/blob"));
		expect(redirect.response.status).toBe(302);
		expect(redirect.response.headers.get("location")).toBe("https://media.example/image.png");
		expect(fallbackFetch).not.toHaveBeenCalled();

		await transport.fetch(input("https://media.example/image.png"));
		expect(fallbackFetch).toHaveBeenCalledOnce();
	});
});

describe("pinned HTTPS response parsing", () => {
	it("parses a bounded content-length response", () => {
		const response = parsePinnedHttpResponse(
			new TextEncoder().encode(
				"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\n\r\ntest",
			),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.body).toEqual(new TextEncoder().encode("test"));
	});

	it("decodes chunked bodies and rejects encoded or ambiguous framing", () => {
		const chunked = parsePinnedHttpResponse(
			new TextEncoder().encode(
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n",
			),
		);
		expect(chunked.body).toEqual(new TextEncoder().encode("test"));
		expect(() =>
			parsePinnedHttpResponse(
				new TextEncoder().encode(
					"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\ntest",
				),
			),
		).toThrow(/content encoding/);
		expect(() =>
			parsePinnedHttpResponse(
				new TextEncoder().encode(
					"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n",
				),
			),
		).toThrow(/framing/);
	});
});
