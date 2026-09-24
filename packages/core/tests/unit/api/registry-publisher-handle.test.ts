/**
 * Drives the publisher handle route against a fake network that answers like
 * the PLC directory, DNS-over-HTTPS, and a bsky.social handle host.
 */

import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/admin/plugins/registry/publisher-handle.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";

// Roles are numeric levels: SUBSCRIBER 10, EDITOR 40, ADMIN 50. `plugins:read`
// requires EDITOR.
const editorUser = { id: "u1", role: 40 };
const subscriberUser = { id: "u2", role: 10 };

const PUBLISHER_DID = "did:plc:iilkrygvrmyedxyfqnwmnfe5";
const HANDLE = "harsh-pranshtech.bsky.social";

function makeContext(
	did: string | null,
	user: unknown = editorUser,
	registry: unknown = "https://registry.emdashcms.com",
): APIContext {
	const url = new URL("https://site.test/_emdash/api/admin/plugins/registry/publisher-handle");
	if (did !== null) url.searchParams.set("did", did);
	return {
		url,
		locals: { emdash: { db: {}, config: { registry } }, user },
	} as unknown as APIContext;
}

let routes: Map<string, () => Response>;

function network(url: URL): Response {
	const route = routes.get(url.href);
	if (!route) throw new TypeError(`fetch failed: ${url.href}`);
	return route();
}

function servePublisher(did: string, wellKnownDid: string) {
	const doc = {
		id: did,
		alsoKnownAs: [`at://${HANDLE}`],
		verificationMethod: [],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: "https://morel.us-east.host.bsky.network",
			},
		],
	};
	routes.set(
		`https://plc.directory/${encodeURIComponent(did)}`,
		() =>
			new Response(JSON.stringify(doc), {
				status: 200,
				headers: { "content-type": "application/did+ld+json; charset=utf-8" },
			}),
	);
	const doh = new URL("https://cloudflare-dns.com/dns-query");
	doh.searchParams.set("name", `_atproto.${HANDLE}`);
	doh.searchParams.set("type", "TXT");
	routes.set(
		doh.href,
		() =>
			new Response(
				JSON.stringify({
					Status: 0,
					TC: false,
					RD: true,
					RA: true,
					AD: false,
					CD: false,
					Question: [{ name: `_atproto.${HANDLE}`, type: 16 }],
				}),
				{ status: 200, headers: { "content-type": "application/dns-json" } },
			),
	);
	routes.set(
		`https://${HANDLE}/.well-known/atproto-did`,
		() =>
			new Response(wellKnownDid, {
				status: 200,
				headers: { "content-type": "text/plain; charset=utf-8" },
			}),
	);
}

describe("registry publisher handle route", () => {
	const fetchSpy = vi.fn(async (input: string | URL | Request) =>
		network(new URL(input instanceof Request ? input.url : input)),
	);

	beforeEach(() => {
		routes = new Map();
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
		fetchSpy.mockClear();
		setDefaultDnsResolver(async () => ["93.184.215.14"]);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		setDefaultDnsResolver(null);
		vi.restoreAllMocks();
	});

	it("requires authentication", async () => {
		expect((await GET(makeContext(PUBLISHER_DID, null))).status).toBe(401);
	});

	it("forbids users without plugins:read", async () => {
		expect((await GET(makeContext(PUBLISHER_DID, subscriberUser))).status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("is unavailable when the registry is not configured", async () => {
		const res = await GET(makeContext(PUBLISHER_DID, editorUser, false));
		expect(res.status).toBe(400);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each([
		["missing", null],
		["not a DID", "mk.gg"],
		["unsupported method", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
		["malformed plc", "did:plc:short"],
		["did:web with an IP address", "did:web:127.0.0.1"],
		["did:web with a path", "did:web:example.com:user:alice"],
		["did:web on a single label", "did:web:localhost"],
	])("rejects a %s did before any lookup", async (_label, did) => {
		const res = await GET(makeContext(did));
		expect(res.status).toBe(400);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns the handle once it resolves back to the publisher DID", async () => {
		servePublisher(PUBLISHER_DID, PUBLISHER_DID);

		const res = await GET(makeContext(PUBLISHER_DID));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			success: true,
			data: { status: "ok", handle: HANDLE },
		});
	});

	it("does not return a handle that resolves to another DID", async () => {
		const impostor = "did:plc:n4mihg5idgr5ne4jigcmbh4k";
		servePublisher(impostor, PUBLISHER_DID);

		const res = await GET(makeContext(impostor));
		const body = (await res.json()) as { data: unknown };

		expect(res.status).toBe(200);
		expect(body.data).toEqual({ status: "invalid" });
		expect(JSON.stringify(body)).not.toContain(HANDLE);
	});

	it("reports a handle whose domain no longer resolves as invalid", async () => {
		const publisher = "did:plc:juoj6qmxkdbbino76mobq2on";
		servePublisher(publisher, publisher);
		setDefaultDnsResolver(async () => []);

		const res = await GET(makeContext(publisher));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, data: { status: "invalid" } });
	});

	it("reports an indeterminate lookup as a retryable failure", async () => {
		const res = await GET(makeContext("did:plc:nna4pfpnegfsgaym44xqhawf"));

		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({
			success: false,
			error: { code: "HANDLE_RESOLUTION_FAILED" },
		});
	});
});
