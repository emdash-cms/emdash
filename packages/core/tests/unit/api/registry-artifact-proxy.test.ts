/**
 * Registry artifact proxy route.
 *
 * The proxy never accepts an artifact URL from the client. The caller
 * addresses an artifact by `(did, slug, version, kind, index)`; the server
 * resolves the *declared* URL from the validated release record fetched from
 * the aggregator, then fetches it. So the route must:
 *   - validate the coordinate params (400 on bad input),
 *   - resolve only the publisher-declared URL (never a caller-supplied one),
 *   - reject private / loopback / link-local hosts on the resolved URL (SSRF),
 *   - reject non-image content types, including SVG (allowlist), allow AVIF,
 *   - cap the body size, and serve image bytes with hardened headers.
 *
 * We drive the route's `GET` directly with a fabricated context, mock the
 * `DiscoveryClient` so release resolution returns a controlled `artifacts`
 * map, stub `globalThis.fetch` for the artifact fetch, and inject a DNS
 * resolver so hostnames resolve to controlled IPs without real network.
 */

import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";

const PNG_1x1 = Uint8Array.from(
	Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bf0a8a0000000049454e44ae426082",
		"hex",
	),
);

// The release record the mocked DiscoveryClient resolves. Tests mutate
// `mockArtifacts` per case to point the declared URL where they need it.
let mockArtifacts: unknown;
let mockReleaseVersion = "1.0.0";

const getPackage = vi.fn(async () => ({ profile: {} }));
const getLatestRelease = vi.fn(async () => ({
	version: mockReleaseVersion,
	release: { version: mockReleaseVersion, artifacts: mockArtifacts },
}));
const listReleases = vi.fn(async () => ({
	releases: [
		{
			version: mockReleaseVersion,
			release: { version: mockReleaseVersion, artifacts: mockArtifacts },
		},
	],
	cursor: undefined,
}));

vi.mock("@emdash-cms/registry-client/discovery", () => ({
	DiscoveryClient: class {
		getPackage = getPackage;
		getLatestRelease = getLatestRelease;
		listReleases = listReleases;
	},
}));

// Imported after the mock is registered.
const { GET } = await import("../../../src/astro/routes/api/admin/plugins/registry/artifact.js");

// Roles are numeric levels: SUBSCRIBER 10, EDITOR 40, ADMIN 50. `plugins:read`
// requires EDITOR.
const adminUser = { id: "u1", role: 50 };
const subscriberUser = { id: "v", role: 10 };

const AGGREGATOR_URL = "https://registry.example.com";

const DEFAULT_PARAMS: Record<string, string> = {
	did: "did:plc:abc123",
	slug: "myplugin",
	kind: "icon",
};

function makeContext(
	params: Record<string, string | null> = DEFAULT_PARAMS,
	user: unknown = adminUser,
	registry: unknown = AGGREGATOR_URL,
): APIContext {
	const u = new URL("https://site.test/_emdash/api/admin/plugins/registry/artifact");
	for (const [key, value] of Object.entries(params)) {
		if (value !== null) u.searchParams.set(key, value);
	}
	return {
		url: u,
		locals: {
			emdash: { db: {}, config: { experimental: { registry } } },
			user,
		},
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
		mockArtifacts = {
			icon: { url: "https://cdn.example.com/icon.png" },
			banner: { url: "https://cdn.example.com/banner.png" },
			screenshots: [
				{ url: "https://cdn.example.com/s0.png" },
				{ url: "https://cdn.example.com/s1.png" },
			],
		};
		mockReleaseVersion = "1.0.0";
		getPackage.mockClear();
		getLatestRelease.mockClear();
		listReleases.mockClear();
		// Default: every hostname resolves to a public IP. Individual tests
		// override the resolver to exercise private-IP rejection.
		setDefaultDnsResolver(async () => ["93.184.216.34"]);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		setDefaultDnsResolver(null);
		vi.restoreAllMocks();
	});

	// ── auth ───────────────────────────────────────────────────────────

	it("requires authentication", async () => {
		const res = await GET(makeContext(DEFAULT_PARAMS, null));
		expect(res.status).toBe(401);
	});

	it("forbids users without plugins:read", async () => {
		const res = await GET(makeContext(DEFAULT_PARAMS, subscriberUser));
		expect(res.status).toBe(403);
	});

	// ── param validation ───────────────────────────────────────────────

	it("rejects a missing did/slug/kind", async () => {
		expect((await GET(makeContext({ slug: "x", kind: "icon" }))).status).toBe(400);
		expect((await GET(makeContext({ did: "did:plc:a", kind: "icon" }))).status).toBe(400);
		expect((await GET(makeContext({ did: "did:plc:a", slug: "x" }))).status).toBe(400);
	});

	it("rejects a malformed did", async () => {
		const res = await GET(makeContext({ did: "notadid", slug: "x", kind: "icon" }));
		expect(res.status).toBe(400);
	});

	it("rejects an invalid slug", async () => {
		const res = await GET(makeContext({ did: "did:plc:a", slug: "../etc", kind: "icon" }));
		expect(res.status).toBe(400);
	});

	it("rejects an unknown kind", async () => {
		const res = await GET(makeContext({ did: "did:plc:a", slug: "x", kind: "favicon" }));
		expect(res.status).toBe(400);
	});

	it("rejects a screenshot without an index", async () => {
		const res = await GET(makeContext({ did: "did:plc:a", slug: "x", kind: "screenshot" }));
		expect(res.status).toBe(400);
	});

	it("rejects a non-integer / negative index", async () => {
		expect(
			(await GET(makeContext({ did: "did:plc:a", slug: "x", kind: "screenshot", index: "1.5" })))
				.status,
		).toBe(400);
		expect(
			(await GET(makeContext({ did: "did:plc:a", slug: "x", kind: "screenshot", index: "-1" })))
				.status,
		).toBe(400);
		expect(
			(await GET(makeContext({ did: "did:plc:a", slug: "x", kind: "screenshot", index: "abc" })))
				.status,
		).toBe(400);
	});

	// ── config ─────────────────────────────────────────────────────────

	it("returns 400 when the registry is not configured", async () => {
		const u = new URL("https://site.test/_emdash/api/admin/plugins/registry/artifact");
		for (const [key, value] of Object.entries(DEFAULT_PARAMS)) u.searchParams.set(key, value);
		const ctx = {
			url: u,
			locals: { emdash: { db: {}, config: { experimental: {} } }, user: adminUser },
		} as unknown as APIContext;
		const res = await GET(ctx);
		expect(res.status).toBe(400);
	});

	// ── resolution → declared URL is proxied ───────────────────────────

	it("resolves the declared icon URL and proxies it", async () => {
		const fetchMock = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		globalThis.fetch = fetchMock;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(200);
		expect(getLatestRelease).toHaveBeenCalled();
		// The fetched URL is the publisher-DECLARED url, never a client param.
		const fetched = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
		expect(fetched).toBe("https://cdn.example.com/icon.png");
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-disposition")).toBe("attachment");
		expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body).toEqual(PNG_1x1);
	});

	it("resolves the declared banner URL", async () => {
		const fetchMock = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		globalThis.fetch = fetchMock;
		const res = await GET(makeContext({ did: "did:plc:abc123", slug: "myplugin", kind: "banner" }));
		expect(res.status).toBe(200);
		const fetched = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
		expect(fetched).toBe("https://cdn.example.com/banner.png");
	});

	it("resolves the declared screenshot URL by index", async () => {
		const fetchMock = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		globalThis.fetch = fetchMock;
		const res = await GET(
			makeContext({ did: "did:plc:abc123", slug: "myplugin", kind: "screenshot", index: "1" }),
		);
		expect(res.status).toBe(200);
		const fetched = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
		expect(fetched).toBe("https://cdn.example.com/s1.png");
	});

	it("paginates listReleases for an explicit version", async () => {
		mockReleaseVersion = "2.0.0";
		const fetchMock = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		globalThis.fetch = fetchMock;
		const res = await GET(
			makeContext({ did: "did:plc:abc123", slug: "myplugin", kind: "icon", version: "2.0.0" }),
		);
		expect(res.status).toBe(200);
		expect(listReleases).toHaveBeenCalled();
		expect(getLatestRelease).not.toHaveBeenCalled();
	});

	// ── 404s ───────────────────────────────────────────────────────────

	it("returns 404 when the requested artifact kind is absent", async () => {
		mockArtifacts = { icon: { url: "https://cdn.example.com/icon.png" } };
		const res = await GET(makeContext({ did: "did:plc:abc123", slug: "myplugin", kind: "banner" }));
		expect(res.status).toBe(404);
	});

	it("returns 404 when a screenshot index is out of range", async () => {
		const res = await GET(
			makeContext({ did: "did:plc:abc123", slug: "myplugin", kind: "screenshot", index: "9" }),
		);
		expect(res.status).toBe(404);
	});

	it("returns 404 when the artifact entry has no usable url", async () => {
		mockArtifacts = { icon: { width: 64 } };
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(404);
	});

	it("returns 404 when no release is found", async () => {
		getLatestRelease.mockResolvedValueOnce({ version: "1.0.0", release: null } as never);
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(404);
	});

	// ── content-type allowlist ─────────────────────────────────────────

	it("allows AVIF", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(PNG_1x1, "image/avif"),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/avif");
	});

	it("rejects SVG (active content removed from the allowlist)", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(new TextEncoder().encode("<svg/>"), "image/svg+xml"),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(415);
	});

	it("rejects a non-image content type", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("<html>nope</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(415);
	});

	it("rejects octet-stream (no content-type sniffing escape)", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(PNG_1x1, "application/octet-stream"),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(415);
	});

	it("normalises a content type with parameters", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(PNG_1x1, "image/png; charset=binary"),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
	});

	// ── SSRF on the RESOLVED url ────────────────────────────────────────

	it("rejects a declared non-http(s) scheme", async () => {
		mockArtifacts = { icon: { url: "file:///etc/passwd" } };
		const fetchMock = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		globalThis.fetch = fetchMock;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a declared cloud metadata IP", async () => {
		mockArtifacts = { icon: { url: "http://169.254.169.254/latest/meta-data/" } };
		const fetchMock = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		globalThis.fetch = fetchMock;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a declared hostname that resolves to a private IP (DNS rebinding)", async () => {
		mockArtifacts = { icon: { url: "https://rebind.attacker.test/icon.png" } };
		setDefaultDnsResolver(async () => ["10.0.0.5"]);
		const fetchMock = vi.fn(async () => imageResponse(PNG_1x1)) as typeof globalThis.fetch;
		globalThis.fetch = fetchMock;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("re-validates a redirect target and rejects a private hop", async () => {
		mockArtifacts = { icon: { url: "https://cdn.example.com/redirect" } };
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
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(400);
	});

	// ── upstream + size ─────────────────────────────────────────────────

	it("rejects an upstream error status", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(502);
	});

	it("rejects an oversized declared content-length", async () => {
		globalThis.fetch = vi.fn(async () =>
			imageResponse(PNG_1x1, "image/png", { "content-length": String(10 * 1024 * 1024) }),
		) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(413);
	});

	it("rejects a streamed body that exceeds the cap with no content-length", async () => {
		const chunk = new Uint8Array(1024 * 1024);
		let emitted = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emitted >= 6) {
					controller.close();
					return;
				}
				emitted++;
				controller.enqueue(chunk);
			},
		});
		const response = new Response(body, {
			status: 200,
			headers: { "content-type": "image/png" },
		});
		expect(response.headers.get("content-length")).toBeNull();
		globalThis.fetch = vi.fn(async () => response) as typeof globalThis.fetch;
		const res = await GET(makeContext(DEFAULT_PARAMS));
		expect(res.status).toBe(413);
	});
});
