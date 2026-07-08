import { describe, expect, it } from "vitest";

import { artifactProxyUrl, extractMediaArtifacts } from "../../src/lib/api/registry";

describe("artifactProxyUrl", () => {
	it("builds a coordinate-based proxy URL for an icon", () => {
		const url = artifactProxyUrl({
			did: "did:plc:abc123",
			slug: "myplugin",
			version: "1.0.0",
			kind: "icon",
		});
		const parsed = new URL(url, "https://site.test");
		expect(parsed.pathname).toBe("/_emdash/api/admin/plugins/registry/artifact");
		expect(parsed.searchParams.get("did")).toBe("did:plc:abc123");
		expect(parsed.searchParams.get("slug")).toBe("myplugin");
		expect(parsed.searchParams.get("version")).toBe("1.0.0");
		expect(parsed.searchParams.get("kind")).toBe("icon");
		expect(parsed.searchParams.get("index")).toBeNull();
	});

	it("encodes coordinate values", () => {
		const url = artifactProxyUrl({ did: "did:plc:a&b", slug: "my plugin", kind: "banner" });
		expect(url).toContain("did=did%3Aplc%3Aa%26b");
		expect(url).toContain("slug=my+plugin");
	});

	it("includes the index for a screenshot", () => {
		const url = artifactProxyUrl({
			did: "did:plc:abc",
			slug: "p",
			version: "2.0.0",
			kind: "screenshot",
			index: 3,
		});
		const parsed = new URL(url, "https://site.test");
		expect(parsed.searchParams.get("kind")).toBe("screenshot");
		expect(parsed.searchParams.get("index")).toBe("3");
	});

	it("omits an empty version", () => {
		const url = artifactProxyUrl({ did: "did:plc:abc", slug: "p", kind: "icon" });
		expect(new URL(url, "https://site.test").searchParams.has("version")).toBe(false);
	});

	it("omits the index for non-screenshot kinds", () => {
		const url = artifactProxyUrl({ did: "did:plc:abc", slug: "p", kind: "icon", index: 5 });
		expect(new URL(url, "https://site.test").searchParams.has("index")).toBe(false);
	});
});

describe("extractMediaArtifacts", () => {
	const icon = { url: "https://x/icon.png", width: 256, height: 256 };
	const banner = { url: "https://x/banner.png", width: 1280, height: 320 };
	const s1 = { url: "https://x/s1.png" };
	const s2 = { url: "https://x/s2.png" };
	const s3 = { url: "https://x/s3.png" };

	it("returns empty results for non-object input", () => {
		expect(extractMediaArtifacts(undefined)).toEqual({ screenshots: [] });
		expect(extractMediaArtifacts(null)).toEqual({ screenshots: [] });
		expect(extractMediaArtifacts("nope")).toEqual({ screenshots: [] });
	});

	it("extracts icon and banner dims without the url", () => {
		const result = extractMediaArtifacts({ package: { url: "https://x/a.tgz" }, icon, banner });
		expect(result.icon).toEqual({ width: 256, height: 256 });
		expect(result.banner).toEqual({ width: 1280, height: 320 });
		expect(result.icon).not.toHaveProperty("url");
		expect(result.banner).not.toHaveProperty("url");
		expect(result.screenshots).toEqual([]);
	});

	it("collects the screenshots array in order with their raw index", () => {
		const result = extractMediaArtifacts({
			package: { url: "https://x/a.tgz" },
			screenshots: [s1, s2, s3],
		});
		expect(result.screenshots.map((s) => s.index)).toEqual([0, 1, 2]);
		for (const shot of result.screenshots) expect(shot).not.toHaveProperty("url");
	});

	it("handles a single-element screenshots array", () => {
		const result = extractMediaArtifacts({ screenshots: [s1] });
		expect(result.screenshots).toEqual([{ index: 0 }]);
	});

	it("ignores a non-array screenshots value", () => {
		expect(extractMediaArtifacts({ screenshots: s1 }).screenshots).toEqual([]);
		expect(extractMediaArtifacts({ screenshots: "nope" }).screenshots).toEqual([]);
	});

	it("ignores the legacy singular `screenshot` key", () => {
		const result = extractMediaArtifacts({ screenshot: s1, "x-screenshot-2": s2 });
		expect(result.screenshots).toEqual([]);
	});

	it("drops malformed entries but preserves the raw index of survivors", () => {
		const result = extractMediaArtifacts({
			icon: { width: 10 },
			screenshots: [{ url: 123 }, s2, { url: "" }, s3],
		});
		// `icon` has no usable url -> dropped entirely.
		expect(result.icon).toBeUndefined();
		// Survivors keep their original array indices (1 and 3), so the proxy
		// resolves the same entry the publisher declared.
		expect(result.screenshots.map((s) => s.index)).toEqual([1, 3]);
	});
});
