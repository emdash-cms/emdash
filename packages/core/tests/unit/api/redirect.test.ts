import { describe, expect, it } from "vitest";

import { isSafeRedirect } from "#api/redirect.js";

describe("isSafeRedirect", () => {
	it("accepts simple relative paths", () => {
		expect(isSafeRedirect("/")).toBe(true);
		expect(isSafeRedirect("/admin")).toBe(true);
		expect(isSafeRedirect("/_emdash/admin")).toBe(true);
		expect(isSafeRedirect("/foo/bar?baz=1")).toBe(true);
	});

	it("rejects protocol-relative URLs (double slash)", () => {
		expect(isSafeRedirect("//evil.com")).toBe(false);
		expect(isSafeRedirect("//evil.com/path")).toBe(false);
	});

	it("rejects backslash bypass (/\\evil.com normalizes to //evil.com)", () => {
		expect(isSafeRedirect("/\\evil.com")).toBe(false);
		expect(isSafeRedirect("/foo\\bar")).toBe(false);
		expect(isSafeRedirect("\\evil.com")).toBe(false);
	});

	it("rejects control characters that browsers strip from URLs", () => {
		expect(isSafeRedirect("/\t/evil.com")).toBe(false);
		expect(isSafeRedirect("/\n/evil.com")).toBe(false);
		expect(isSafeRedirect("/\r/evil.com")).toBe(false);
		expect(isSafeRedirect("/admin\u0000")).toBe(false);
		expect(isSafeRedirect("/admin\u001f")).toBe(false);
		expect(isSafeRedirect("/admin\u007f")).toBe(false);
	});

	it("rejects URLs that do not start with /", () => {
		expect(isSafeRedirect("https://evil.com")).toBe(false);
		expect(isSafeRedirect("http://evil.com")).toBe(false);
		expect(isSafeRedirect("evil.com")).toBe(false);
		expect(isSafeRedirect("")).toBe(false);
	});

	it("rejects null and undefined", () => {
		expect(isSafeRedirect(null)).toBe(false);
		expect(isSafeRedirect(undefined)).toBe(false);
	});
});
