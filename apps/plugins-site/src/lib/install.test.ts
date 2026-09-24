import { describe, expect, it, vi } from "vitest";

import { normalizeSiteOrigin, pluginAdminUrl, probeEmDashSite } from "./install.js";

const signal = new AbortController().signal;

describe("plugin install handoff", () => {
	it("normalizes an HTTPS site address to its origin", () => {
		expect(normalizeSiteOrigin("cms.example.com/_emdash/admin")).toBe("https://cms.example.com");
	});

	it("allows local HTTP development sites", () => {
		expect(normalizeSiteOrigin("http://localhost:4321/example")).toBe("http://localhost:4321");
	});

	it("rejects insecure remote sites and URLs containing credentials", () => {
		expect(normalizeSiteOrigin("http://cms.example.com")).toBeUndefined();
		expect(normalizeSiteOrigin("https://user:secret@cms.example.com")).toBeUndefined();
	});

	it("rejects site addresses that are too long to persist safely", () => {
		expect(normalizeSiteOrigin(`https://${"a".repeat(2_048)}.example`)).toBeUndefined();
	});

	it("builds an encoded admin registry detail URL", () => {
		expect(pluginAdminUrl("https://cms.example.com", "@plugins.example.com", "contact-form")).toBe(
			"https://cms.example.com/_emdash/admin/plugins/registry/%40plugins.example.com/contact-form",
		);
	});

	it("uses the health endpoint to confirm registry support", async () => {
		const request = vi.fn(async () =>
			Response.json({
				success: true,
				data: { product: "emdash", version: "0.39.0", registry: true },
			}),
		);

		await expect(probeEmDashSite("https://cms.example.com", signal, request)).resolves.toBe(
			"registry",
		);
		expect(request).toHaveBeenCalledOnce();
	});

	it("reports when the health endpoint says the registry is disabled", async () => {
		const request = vi.fn(async () =>
			Response.json({
				success: true,
				data: { product: "emdash", version: "0.39.0", registry: false },
			}),
		);

		await expect(probeEmDashSite("https://cms.example.com", signal, request)).resolves.toBe(
			"registry-disabled",
		);
		expect(request).toHaveBeenCalledOnce();
	});

	it("falls back to OAuth metadata for older EmDash sites", async () => {
		const request = vi.fn(async (url: URL) => {
			if (url.pathname === "/_emdash/api/health") return new Response(null, { status: 404 });
			return Response.json({
				issuer: "https://cms.example.com/_emdash",
				authorization_endpoint: "https://cms.example.com/_emdash/oauth/authorize",
				token_endpoint: "https://cms.example.com/_emdash/api/oauth/token",
			});
		});

		await expect(probeEmDashSite("https://cms.example.com", signal, request)).resolves.toBe(
			"legacy",
		);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not block sites that cannot expose either probe", async () => {
		const request = vi.fn(async () => {
			throw new TypeError("Network request blocked");
		});

		await expect(probeEmDashSite("https://private.example.com", signal, request)).resolves.toBe(
			"unknown",
		);
	});
});
