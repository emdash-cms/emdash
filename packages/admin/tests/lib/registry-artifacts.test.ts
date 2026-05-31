import { describe, expect, it } from "vitest";

import { artifactProxyUrl, extractMediaArtifacts } from "../../src/lib/api/registry";

describe("artifactProxyUrl", () => {
	it("routes an https artifact URL through the server proxy", () => {
		const url = artifactProxyUrl("https://cdn.example.com/gallery/1.0.0/icon.png");
		expect(url).toBe(
			"/_emdash/api/admin/plugins/registry/artifact?url=https%3A%2F%2Fcdn.example.com%2Fgallery%2F1.0.0%2Ficon.png",
		);
	});

	it("returns null for a javascript: URL (lexicon uri permits it)", () => {
		expect(artifactProxyUrl("javascript:alert(1)")).toBeNull();
	});

	it("returns null for a relative URL", () => {
		expect(artifactProxyUrl("/icon.png")).toBeNull();
	});

	it("returns null for a non-string / empty value", () => {
		expect(artifactProxyUrl(undefined)).toBeNull();
		expect(artifactProxyUrl(42)).toBeNull();
		expect(artifactProxyUrl("")).toBeNull();
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

	it("extracts icon and banner", () => {
		const result = extractMediaArtifacts({ package: { url: "https://x/a.tgz" }, icon, banner });
		expect(result.icon).toEqual(icon);
		expect(result.banner).toEqual(banner);
		expect(result.screenshots).toEqual([]);
	});

	it("collects the screenshot slot plus x-screenshot-N overflow, in order", () => {
		const result = extractMediaArtifacts({
			package: { url: "https://x/a.tgz" },
			screenshot: s1,
			"x-screenshot-2": s2,
			"x-screenshot-3": s3,
		});
		expect(result.screenshots.map((s) => s.url)).toEqual([s1.url, s2.url, s3.url]);
	});

	it("orders overflow keys numerically, not lexically", () => {
		const result = extractMediaArtifacts({
			screenshot: s1,
			"x-screenshot-10": { url: "https://x/s10.png" },
			"x-screenshot-2": s2,
		});
		expect(result.screenshots.map((s) => s.url)).toEqual([s1.url, s2.url, "https://x/s10.png"]);
	});

	it("skips entries without a usable url", () => {
		const result = extractMediaArtifacts({
			icon: { width: 10 },
			screenshot: { url: 123 },
			"x-screenshot-2": s2,
		});
		expect(result.icon).toBeUndefined();
		// The malformed `screenshot` is dropped; the valid overflow survives.
		expect(result.screenshots.map((s) => s.url)).toEqual([s2.url]);
	});
});
