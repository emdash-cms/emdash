import { describe, it, expect } from "vitest";

import { buildEmDashCsp } from "../../../src/astro/middleware/csp.js";

describe("buildEmDashCsp", () => {
	it("includes https: in img-src to allow external images", () => {
		const csp = buildEmDashCsp();
		const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"));
		expect(imgSrc).toContain("https:");
	});

	it("still includes self, data:, and blob: in img-src", () => {
		const csp = buildEmDashCsp();
		const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"));
		expect(imgSrc).toContain("'self'");
		expect(imgSrc).toContain("data:");
		expect(imgSrc).toContain("blob:");
	});

	it("keeps connect-src restricted to self", () => {
		const csp = buildEmDashCsp();
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self'");
	});

	it("allows the configured registry aggregator origin in connect-src", () => {
		const csp = buildEmDashCsp({ aggregatorUrl: "https://registry.emdashcms.com/xrpc" });
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self' https://registry.emdashcms.com");
	});

	it("allows shorthand registry URLs in connect-src", () => {
		const csp = buildEmDashCsp("https://registry.emdashcms.com");
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self' https://registry.emdashcms.com");
	});

	it("allows the configured storage endpoint origin in connect-src", () => {
		const csp = buildEmDashCsp(undefined, "https://xxx.r2.cloudflarestorage.com");
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self' https://xxx.r2.cloudflarestorage.com");
	});

	it("ignores a storage endpoint that isn't http(s)", () => {
		const csp = buildEmDashCsp(undefined, "file:///tmp/uploads");
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self'");
	});

	it("ignores a malformed storage endpoint", () => {
		const csp = buildEmDashCsp(undefined, "not a url");
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self'");
	});

	it("allows both the registry and storage endpoint origins together", () => {
		const csp = buildEmDashCsp(
			"https://registry.emdashcms.com",
			"https://xxx.r2.cloudflarestorage.com",
		);
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe(
			"connect-src 'self' https://registry.emdashcms.com https://xxx.r2.cloudflarestorage.com",
		);
	});

	it("does not duplicate the origin when storage endpoint and registry share it", () => {
		const csp = buildEmDashCsp("https://shared.example.com", "https://shared.example.com/bucket");
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self' https://shared.example.com");
	});

	it("blocks framing with frame-ancestors none", () => {
		const csp = buildEmDashCsp();
		expect(csp).toContain("frame-ancestors 'none'");
	});
});
