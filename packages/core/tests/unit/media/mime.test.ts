import { describe, it, expect } from "vitest";

import {
	matchesMimeAllowlist,
	normalizeMime,
	expandExtensionShorthand,
} from "../../../src/media/mime.js";

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

	it("is case-insensitive per RFC 2045", () => {
		expect(matchesMimeAllowlist("Image/JPEG", ["image/jpeg"])).toBe(true);
		expect(matchesMimeAllowlist("image/jpeg", ["Image/JPEG"])).toBe(true);
		expect(matchesMimeAllowlist("IMAGE/PNG", ["image/"])).toBe(true);
		expect(matchesMimeAllowlist("VIDEO/MP4", ["video/"])).toBe(true);
	});

	it("strips MIME parameters before matching", () => {
		expect(matchesMimeAllowlist("text/html; charset=utf-8", ["text/html"])).toBe(true);
		expect(matchesMimeAllowlist("text/plain; charset=iso-8859-1", ["text/"])).toBe(true);
		expect(matchesMimeAllowlist("application/json; charset=utf-8", ["application/pdf"])).toBe(
			false,
		);
	});
});

describe("normalizeMime", () => {
	it("lowercases the type", () => {
		expect(normalizeMime("Image/JPEG")).toBe("image/jpeg");
		expect(normalizeMime("APPLICATION/PDF")).toBe("application/pdf");
	});

	it("strips parameters", () => {
		expect(normalizeMime("text/html; charset=utf-8")).toBe("text/html");
		expect(normalizeMime("text/plain;charset=iso-8859-1")).toBe("text/plain");
	});

	it("leaves already-normalized types unchanged", () => {
		expect(normalizeMime("image/png")).toBe("image/png");
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
