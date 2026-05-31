/**
 * Registry artifact proxy route.
 *
 * The proxy fetches ARBITRARY publisher-supplied URLs, so it must:
 *   - reject private / loopback / link-local hosts (SSRF defence),
 *   - reject non-image content types (allowlist),
 *   - pass image bytes through with a private, no-store cache header.
 *
 * We drive the route's `GET` directly with a fabricated context, stub
 * `globalThis.fetch`, and inject a DNS resolver so hostnames resolve to
 * controlled IPs without real network access.
 */

import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/admin/plugins/registry/artifact.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";

const PNG_1x1 = Uint8Array.from(
	Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bf0a8a0000000049454e44ae426082",
		"hex",
	),
);

// Roles are numeric levels: SUBSCRIBER 10, EDITOR 40, ADMIN 50. `plugins:read`
// requires EDITOR.
const adminUser = { id: "u1", role: 50 };
const subscriberUser = { id: "v", role: 10 };

function makeContext(target: string | null, user: unknown = adminUser): APIContext {
	const u = new URL("https://site.test/_emdash/api/admin/plugins/registry/artifact");
	if (target !== null) u.searchParams.set("url", target);
	return {
		url: u,
		locals: { emdash: { db: {} }, user },
	} as unknown as APIContext;
}

function imageResponse(
	bytes: Uint8Array,
	contentType = "image/png",
	extra: Record<string, string> = {},
) {
	return new Response(bytes, { status: 200, headers: { "content-type": contentType, ...extra } });
}

describe("registry artifact proxy", () => {
	let realFetch: typeof globalThis.fetch;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		// Default: every hostname resolves to a public IP. Individual tests
		// override the resolver to exercise private-IP rejection.
		setDefaultDnsResolver(async () => ["93.184.216.34"]);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		setDefaultDnsResolver(null);
		vi.restoreAllMocks();
	});

	it("requires authentication", async () => {
		const res = await GET(makeContext("https://cdn.example.com/icon.png", null));
		expect(res.status).toBe(401);
	});

	it("forbids users without plugins:read", async () => {
		const res = await GET(makeContext("https://cdn.example.com/icon.png", subscriberUser));
		// subscriber lacks plugins:read (editor minimum), so 403.
		expect(res.status).toBe(403);
	});

	it("rejects a missing url param", async () => {
		const res = await GET(makeContext(null));
		expect(res.status).toBe(400);
	});

	it("passes a happy-path image through with a private cache header", async () => {
		globalThis.fetch = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://cdn.example.com/icon.png"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		// Active-content (SVG) defence: force download + sandbox CSP so a direct
		// navigation to the proxy URL can't execute script in the admin origin.
		expect(res.headers.get("content-disposition")).toBe("attachment");
		expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body).toEqual(PNG_1x1);
	});

	it("normalises a content type with parameters", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(PNG_1x1, "image/png; charset=binary"),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://cdn.example.com/icon.png"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
	});

	it("rejects a non-image content type", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("<html>nope</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://cdn.example.com/icon.png"));
		expect(res.status).toBe(415);
	});

	it("rejects octet-stream (no content-type sniffing escape)", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(PNG_1x1, "application/octet-stream"),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://cdn.example.com/icon.png"));
		expect(res.status).toBe(415);
	});

	it("rejects a non-http(s) scheme", async () => {
		globalThis.fetch = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		const res = await GET(makeContext("file:///etc/passwd"));
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	// Loopback / localhost are deliberately permitted under `import.meta.env.DEV`
	// (the same dev escape hatch `assertSafeArtifactUrl` documents), so they are
	// not asserted here — vitest runs in DEV. Production rejection of those is
	// covered by `assertSafeArtifactUrl`'s own suite. The link-local, private,
	// and DNS-rebinding cases below hold in every environment.

	it("rejects the cloud metadata IP", async () => {
		globalThis.fetch = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		const res = await GET(makeContext("http://169.254.169.254/latest/meta-data/"));
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects a hostname that resolves to a private IP (DNS rebinding)", async () => {
		setDefaultDnsResolver(async () => ["10.0.0.5"]);
		globalThis.fetch = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://rebind.attacker.test/icon.png"));
		expect(res.status).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("re-validates a redirect target and rejects a private hop", async () => {
		setDefaultDnsResolver(async (host) =>
			host === "cdn.example.com" ? ["93.184.216.34"] : ["169.254.169.254"],
		);
		globalThis.fetch = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://internal.attacker.test/secret" },
				}),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://cdn.example.com/redirect"));
		expect(res.status).toBe(400);
	});

	it("rejects an upstream error status", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://cdn.example.com/missing.png"));
		expect(res.status).toBe(502);
	});

	it("rejects an oversized declared content-length", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(PNG_1x1, "image/png", { "content-length": String(10 * 1024 * 1024) }),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext("https://cdn.example.com/huge.png"));
		expect(res.status).toBe(413);
	});
});
