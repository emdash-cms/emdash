import { describe, expect, test, vi } from "vitest";

import {
	forwardAnonymousReadWith,
	prepareAnonymousRead,
} from "../../.flue/lib/anonymous-egress.js";

describe("anonymous sandbox egress", () => {
	test("allows public HTTPS reads and strips sandbox credentials", async () => {
		const request = new Request("https://example.com/archive.tgz", {
			headers: {
				authorization: "Bearer sandbox-secret",
				cookie: "session=sandbox-secret",
				"proxy-authorization": "Basic sandbox-secret",
				"x-emdash-push-capability": "sandbox-capability",
			},
		});
		const prepared = prepareAnonymousRead(request);

		expect(prepared).toMatchObject({ allowed: true });
		if (!prepared.allowed) throw new Error("expected request to be allowed");
		for (const header of [
			"authorization",
			"cookie",
			"proxy-authorization",
			"x-emdash-push-capability",
		]) {
			expect(prepared.request.headers.has(header)).toBe(false);
		}
	});

	test("allows HEAD but denies writes and plaintext HTTP", () => {
		expect(
			prepareAnonymousRead(new Request("https://example.com/file", { method: "HEAD" })),
		).toMatchObject({ allowed: true });
		expect(
			prepareAnonymousRead(
				new Request("https://example.com/file", { method: "POST", body: "data" }),
			),
		).toMatchObject({ allowed: false, reason: expect.stringMatching(/GET|HEAD/) });
		expect(prepareAnonymousRead(new Request("http://example.com/file"))).toMatchObject({
			allowed: false,
			reason: expect.stringMatching(/HTTPS/),
		});
	});

	test("denies loopback, private, link-local, and metadata targets", () => {
		for (const url of [
			"https://localhost/file",
			"https://127.0.0.1/file",
			"https://10.0.0.1/file",
			"https://172.16.0.1/file",
			"https://192.168.0.1/file",
			"https://169.254.169.254/latest/meta-data",
			"https://[::1]/file",
			"https://[fd00::1]/file",
			"https://metadata.google.internal/file",
		]) {
			expect(prepareAnonymousRead(new Request(url))).toMatchObject({ allowed: false });
		}
	});

	test("forwards the sanitized request without exposing credentials", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("binary"));
		const request = new Request("https://release-assets.githubusercontent.com/file", {
			headers: { authorization: "Bearer sandbox-secret" },
		});

		await expect(forwardAnonymousReadWith(request, fetchMock)).resolves.toHaveProperty(
			"status",
			200,
		);
		expect(fetchMock).toHaveBeenCalledOnce();
		const forwarded = fetchMock.mock.calls[0]?.[0];
		expect(forwarded).toBeInstanceOf(Request);
		if (!(forwarded instanceof Request)) throw new Error("expected a Request");
		expect(forwarded.headers.has("authorization")).toBe(false);
	});
});
