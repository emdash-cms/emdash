import { describe, it, expect } from "vitest";

import { buildEmDashCsp } from "../../src/astro/middleware/csp";

const CONNECT_RE = /connect-src[^;]*https:\/\/storage\.example\.test/;
const IMG_RE = /img-src[^;]*https:\/\/storage\.example\.test/;

describe("buildEmDashCsp", () => {
	it("includes storage origin when provided", () => {
		const policy = buildEmDashCsp(undefined, "https://storage.example.test/some/path");
		expect(policy).toContain("https://storage.example.test");
		expect(policy).toMatch(CONNECT_RE);
		expect(policy).toMatch(IMG_RE);
	});

	it("ignores invalid storage URL and does not throw", () => {
		expect(() => buildEmDashCsp(undefined, "not-a-url")).not.toThrow();
		const policy = buildEmDashCsp(undefined, "not-a-url");
		expect(policy).toContain("connect-src 'self'");
	});
});
