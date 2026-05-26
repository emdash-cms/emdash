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

	it("blocks framing with frame-ancestors none", () => {
		const csp = buildEmDashCsp();
		expect(csp).toContain("frame-ancestors 'none'");
	});
});
