import { describe, it, expect } from "vitest";

import { matchesMimeAllowlist, expandExtensionShorthand } from "../../../src/media/mime.js";

describe("matchesMimeAllowlist", () => {
	it("matches exact MIME types", () => {
		expect(matchesMimeAllowlist("image/png", ["image/png"])).toBe(true);
		expect(matchesMimeAllowlist("image/jpeg", ["image/png"])).toBe(false);
	});

	it("matches type/ prefix entries", () => {
		expect(matchesMimeAllowlist("image/png", ["image/"])).toBe(true);
		expect(matchesMimeAllowlist("image/anything", ["image/"])).toBe(true);
		expect(matchesMimeAllowlist("video/mp4", ["image/"])).toBe(false);
	});

	it("matches against a mixed list", () => {
		const list = ["application/pdf", "image/", "application/zip"];
		expect(matchesMimeAllowlist("image/jpeg", list)).toBe(true);
		expect(matchesMimeAllowlist("application/pdf", list)).toBe(true);
		expect(matchesMimeAllowlist("application/zip", list)).toBe(true);
		expect(matchesMimeAllowlist("video/mp4", list)).toBe(false);
	});

	it("returns false for an empty list", () => {
		expect(matchesMimeAllowlist("image/png", [])).toBe(false);
	});

	it("ignores malformed entries (no slash) without throwing", () => {
		expect(matchesMimeAllowlist("image/png", ["image"])).toBe(false);
		expect(matchesMimeAllowlist("image/png", [""])).toBe(false);
	});
});

describe("expandExtensionShorthand", () => {
	it("passes through an already-MIME entry", () => {
		expect(expandExtensionShorthand("image/png")).toBe("image/png");
		expect(expandExtensionShorthand("image/")).toBe("image/");
	});

	it("expands known dot-extensions", () => {
		expect(expandExtensionShorthand(".pdf")).toBe("application/pdf");
		expect(expandExtensionShorthand(".PDF")).toBe("application/pdf");
		expect(expandExtensionShorthand(".docx")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
	});

	it("returns null for unknown shorthand", () => {
		expect(expandExtensionShorthand(".xyz")).toBeNull();
		expect(expandExtensionShorthand("notamime")).toBeNull();
		expect(expandExtensionShorthand("")).toBeNull();
	});
});
