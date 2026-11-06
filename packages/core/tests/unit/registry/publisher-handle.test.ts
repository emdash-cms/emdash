/**
 * Runs the real resolver against a fake network whose responses mirror what
 * plc.directory, cloudflare-dns.com, and bsky.social return.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePublisherHandle } from "../../../src/registry/publisher-handle.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";

type Route = (url: URL) => Response | Promise<Response>;

const PUBLIC_ADDRESS = "93.184.215.14";

let routes: Map<string, Route>;
let requested: string[];
let addresses: Map<string, string[]>;

/**
 * Behaves like `fetch`: unknown hosts fail, an abort rejects a pending request,
 * and redirects are followed unless `manual`.
 */
async function network(
	url: URL,
	init: { signal?: AbortSignal | null; redirect?: RequestRedirect } = {},
): Promise<Response> {
	requested.push(url.href);
	const { signal } = init;
	if (signal?.aborted) throw signal.reason;
	const route = routes.get(url.href);
	if (!route) throw new TypeError(`fetch failed: ${url.href}`);
	const response = await new Promise<Response>((resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		Promise.resolve(route(url)).then(resolve, reject);
	});
	const location = response.headers.get("location");
	if (location && response.status >= 300 && response.status < 400 && init.redirect !== "manual") {
		return network(new URL(location, url), init);
	}
	return response;
}

function plcDocument(did: string, alsoKnownAs?: string[]) {
	return {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
			"https://w3id.org/security/suites/secp256k1-2019/v1",
		],
		id: did,
		...(alsoKnownAs ? { alsoKnownAs } : {}),
		verificationMethod: [
			{
				id: `${did}#atproto`,
				type: "Multikey",
				controller: did,
				publicKeyMultibase: "zQ3shh5uZnjn2jptqwQqMRquwAk21WsWWwZvfhk6zxKYqs39x",
			},
		],
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: "https://pds.example.com",
			},
		],
	};
}

function servePlc(did: string, alsoKnownAs?: string[]) {
	routes.set(
		`https://plc.directory/${encodeURIComponent(did)}`,
		() =>
			new Response(JSON.stringify(plcDocument(did, alsoKnownAs)), {
				status: 200,
				headers: { "content-type": "application/did+ld+json; charset=utf-8" },
			}),
	);
}

function dohUrl(handle: string): string {
	const url = new URL("https://cloudflare-dns.com/dns-query");
	url.searchParams.set("name", `_atproto.${handle}`);
	url.searchParams.set("type", "TXT");
	return url.href;
}

function serveDns(handle: string, answer: { did: string } | "empty" | "nxdomain") {
	const name = `_atproto.${handle}`;
	const body = {
		Status: answer === "nxdomain" ? 3 : 0,
		TC: false,
		RD: true,
		RA: true,
		AD: false,
		CD: false,
		Question: [{ name, type: 16 }],
		...(typeof answer === "object"
			? { Answer: [{ name, type: 16, TTL: 300, data: `"did=${answer.did}"` }] }
			: {
					Authority: [
						{
							name: handle.split(".").slice(-2).join("."),
							type: 6,
							TTL: 900,
							data: "ns-360.awsdns-45.com. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400",
						},
					],
				}),
	};
	routes.set(
		dohUrl(handle),
		() =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/dns-json" },
			}),
	);
}

function serveWellKnown(handle: string, answer: { did: string } | "not-found") {
	addresses.set(handle, [PUBLIC_ADDRESS]);
	routes.set(`https://${handle}/.well-known/atproto-did`, () =>
		answer === "not-found"
			? new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } })
			: new Response(answer.did, {
					status: 200,
					headers: { "content-type": "text/plain; charset=utf-8" },
				}),
	);
}

describe("resolvePublisherHandle", () => {
	beforeEach(() => {
		routes = new Map();
		requested = [];
		addresses = new Map();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
			network(new URL(input instanceof Request ? input.url : input), init),
		);
		setDefaultDnsResolver(async (hostname) => addresses.get(hostname) ?? []);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		setDefaultDnsResolver(null);
		vi.restoreAllMocks();
	});

	it("verifies a handle whose DNS record points back to the DID", async () => {
		const did = "did:plc:uwbl4k3tza7eyjv3morkrld2";
		servePlc(did, ["at://Mk.GG"]);
		serveDns("mk.gg", { did });
		serveWellKnown("mk.gg", "not-found");

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "ok", handle: "mk.gg" });
	});

	it("verifies a hosted handle through the HTTPS well-known when DNS has no record", async () => {
		const did = "did:plc:5htva5ewwisu7gfjou2o4mee";
		servePlc(did, ["at://cfreear.bsky.social"]);
		serveDns("cfreear.bsky.social", "empty");
		serveWellKnown("cfreear.bsky.social", { did });

		await expect(resolvePublisherHandle(did)).resolves.toEqual({
			status: "ok",
			handle: "cfreear.bsky.social",
		});
		expect(requested).toContain("https://cfreear.bsky.social/.well-known/atproto-did");
	});

	it("does not verify a claimed handle that points at a different DID", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
		servePlc(did, ["at://victim.example.com"]);
		serveDns("victim.example.com", { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" });
		serveWellKnown("victim.example.com", { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" });

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "invalid" });
	});

	it("does not verify a hosted handle whose well-known names a different DID", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaab";
		servePlc(did, ["at://someone-else.bsky.social"]);
		serveDns("someone-else.bsky.social", "empty");
		serveWellKnown("someone-else.bsky.social", { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" });

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "invalid" });
	});

	it("marks a claimed handle that resolves nowhere as invalid", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaac";
		servePlc(did, ["at://unclaimed.example.org"]);
		serveDns("unclaimed.example.org", "nxdomain");
		serveWellKnown("unclaimed.example.org", "not-found");

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "invalid" });
	});

	it("marks a claimed handle whose domain no longer exists as invalid", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaal";
		servePlc(did, ["at://lapsed.example.org"]);
		serveDns("lapsed.example.org", "nxdomain");

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "invalid" });
		expect(requested).not.toContain("https://lapsed.example.org/.well-known/atproto-did");
	});

	it("treats a failed address lookup for the handle host as indeterminate", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaam";
		servePlc(did, ["at://outage.example.org"]);
		serveDns("outage.example.org", "nxdomain");
		setDefaultDnsResolver(async () => {
			throw new Error("DoH A lookup failed: rcode=2");
		});

		await expect(resolvePublisherHandle(did)).resolves.toBeNull();
		expect(requested).not.toContain("https://outage.example.org/.well-known/atproto-did");
	});

	it("reports no handle for a did:web host that no longer exists", async () => {
		const did = "did:web:gone.example.org";

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "missing" });
		expect(requested).not.toContain("https://gone.example.org/.well-known/did.json");
	});

	it("reports no handle when the DID document claims none", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaad";
		servePlc(did);

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "missing" });
		expect(requested).toEqual([`https://plc.directory/${encodeURIComponent(did)}`]);
	});

	it("reports no handle for a DID the directory does not know", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaae";
		routes.set(
			`https://plc.directory/${encodeURIComponent(did)}`,
			() =>
				new Response(JSON.stringify({ message: `DID not registered: ${did}` }), {
					status: 404,
					headers: { "content-type": "application/json; charset=utf-8" },
				}),
		);

		await expect(resolvePublisherHandle(did)).resolves.toEqual({ status: "missing" });
	});

	it("treats a network failure on the only reachable method as indeterminate", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaf";
		servePlc(did, ["at://flaky.example.net"]);
		serveDns("flaky.example.net", "nxdomain");
		addresses.set("flaky.example.net", [PUBLIC_ADDRESS]);

		await expect(resolvePublisherHandle(did)).resolves.toBeNull();
	});

	it("never contacts a handle host that resolves to a private address", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaag";
		servePlc(did, ["at://intranet.example.com"]);
		serveDns("intranet.example.com", "empty");
		routes.set(
			"https://intranet.example.com/.well-known/atproto-did",
			() => new Response(did, { status: 200, headers: { "content-type": "text/plain" } }),
		);
		addresses.set("intranet.example.com", ["10.0.0.5"]);

		await expect(resolvePublisherHandle(did)).resolves.toBeNull();
		expect(requested).not.toContain("https://intranet.example.com/.well-known/atproto-did");
	});

	it("never contacts a did:web host that resolves to a private address", async () => {
		const did = "did:web:metadata.example.com";
		addresses.set("metadata.example.com", ["169.254.169.254"]);
		routes.set(
			"https://metadata.example.com/.well-known/did.json",
			() =>
				new Response(JSON.stringify(plcDocument(did, ["at://metadata.example.com"])), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await expect(resolvePublisherHandle(did)).resolves.toBeNull();
		expect(requested).not.toContain("https://metadata.example.com/.well-known/did.json");
	});

	it("does not follow a redirect from the directory", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaah";
		routes.set(
			`https://plc.directory/${encodeURIComponent(did)}`,
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://attacker.example.com/doc.json" },
				}),
		);

		await expect(resolvePublisherHandle(did)).resolves.toBeNull();
		expect(requested).not.toContain("https://attacker.example.com/doc.json");
	});

	it("gives up on a host that never answers once the lookup deadline passes", async () => {
		const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaai";
		servePlc(did, ["at://slow.example.com"]);
		serveDns("slow.example.com", "empty");
		addresses.set("slow.example.com", [PUBLIC_ADDRESS]);
		routes.set("https://slow.example.com/.well-known/atproto-did", () => new Promise(() => {}));
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);

		const pending = resolvePublisherHandle(did);
		await vi.waitFor(() =>
			expect(requested).toContain("https://slow.example.com/.well-known/atproto-did"),
		);
		deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));

		await expect(pending).resolves.toBeNull();
	});

	it("serves a conclusive result from cache and retries an indeterminate one", async () => {
		const verified = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaj";
		servePlc(verified, ["at://cached.example.com"]);
		serveDns("cached.example.com", { did: verified });
		serveWellKnown("cached.example.com", "not-found");

		await expect(resolvePublisherHandle(verified)).resolves.toMatchObject({ status: "ok" });
		const afterFirst = requested.length;
		await expect(resolvePublisherHandle(verified)).resolves.toMatchObject({ status: "ok" });
		expect(requested).toHaveLength(afterFirst);

		const unreachable = "did:plc:aaaaaaaaaaaaaaaaaaaaaaak";
		await expect(resolvePublisherHandle(unreachable)).resolves.toBeNull();
		servePlc(unreachable);
		await expect(resolvePublisherHandle(unreachable)).resolves.toEqual({ status: "missing" });
	});
});
