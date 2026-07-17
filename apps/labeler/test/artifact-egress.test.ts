/**
 * SSRF egress wiring. The hardening itself lives in `fetchVerifiedResource`
 * (covered by `artifact-acquisition.test.ts`); these tests prove this module
 * wires the ratified DoH resolver and a credential-free pass-through fetch, and
 * that the composed egress drives the resolver-gated fetch — a fake DoH keeps
 * every case off the network.
 */

import type { HostnameResolver } from "@emdash-cms/registry-verification";
import { cloudflareDohResolver } from "emdash/security/ssrf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireArtifact, type AcquisitionDeps } from "../src/artifact-acquisition.js";
import { createArtifactEgress } from "../src/artifact-egress.js";
import { canonicalBundle, checksumOf } from "./bundle-fixture.js";

const PUBLIC_ADDRESS = "203.0.113.5";
const PRIVATE_ADDRESS = "10.0.0.5";

afterEach(() => {
	vi.restoreAllMocks();
});

async function target(url = "https://cdn.example.test/plugin.tgz") {
	const bytes = await canonicalBundle();
	return { url, checksum: await checksumOf(bytes), slug: "test-plugin", version: "1.0.0" };
}

function egressDeps(resolveHostname: HostnameResolver): AcquisitionDeps {
	const { fetch } = createArtifactEgress();
	return { fetch, resolveHostname };
}

describe("createArtifactEgress: wiring", () => {
	it("resolves hostnames with the ratified cloudflareDohResolver", () => {
		expect(createArtifactEgress().resolveHostname).toBe(cloudflareDohResolver);
	});

	it("forwards to globalThis.fetch without adding headers or credentials", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array()));
		const { fetch } = createArtifactEgress();
		const url = new URL("https://cdn.example.test/plugin.tgz");
		const init = {
			method: "GET",
			redirect: "manual",
			signal: new AbortController().signal,
		} as const;

		await fetch(url, init);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(url, init);
		const [, forwardedInit] = spy.mock.calls[0]!;
		expect(forwardedInit).toBe(init);
		expect((forwardedInit as RequestInit).headers).toBeUndefined();
	});
});

describe("createArtifactEgress: composed SSRF enforcement", () => {
	it("fetches through the pass-through when the host resolves public", async () => {
		const bytes = await canonicalBundle();
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));

		const result = await acquireArtifact(
			egressDeps(async () => [PUBLIC_ADDRESS]),
			await target(),
		);

		expect(result.success).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("rejects a host that resolves to a private address before any fetch is made", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array()));

		const result = await acquireArtifact(
			egressDeps(async () => [PRIVATE_ADDRESS]),
			await target(),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({ kind: "policy-rejection", code: "HOST_REJECTED" });
		expect(spy).not.toHaveBeenCalled();
	});

	it("fails closed and does not fetch when DoH resolves no addresses", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array()));

		const result = await acquireArtifact(
			egressDeps(async () => []),
			await target(),
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({ code: "HOST_REJECTED" });
		expect(spy).not.toHaveBeenCalled();
	});

	it("re-resolves each redirect hop and rejects a redirect into a private host", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://internal.example.test/plugin.tgz" },
				}),
			)
			.mockResolvedValue(new Response(new Uint8Array()));
		const resolveHostname: HostnameResolver = async (hostname) =>
			hostname === "internal.example.test" ? [PRIVATE_ADDRESS] : [PUBLIC_ADDRESS];

		const result = await acquireArtifact(egressDeps(resolveHostname), await target());

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toMatchObject({ kind: "policy-rejection", code: "HOST_REJECTED" });
		// The first hop was fetched; the private redirect target was rejected at
		// resolution, before its own fetch.
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
