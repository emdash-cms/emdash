import { describe, expect, it } from "vitest";

import {
	isSafeHref,
	isSafeUrlFieldValue,
	isSafeUrlFieldWriteValue,
	sanitizeHref,
} from "../../../src/utils/url.js";

const offSiteRelativeUrls = [
	"//evil.example/path",
	"/\\evil.example/path",
	"/\t/evil.example/path",
	"\t//evil.example/path",
	"\u0000//evil.example/path",
	"\\\\evil.example/path",
];

describe("URL safety", () => {
	it.each(offSiteRelativeUrls)("rejects browser-normalized off-site URL %j", (value) => {
		expect(new URL(value, "https://site.example/").origin).toBe("https://evil.example");
		expect(isSafeHref(value)).toBe(false);
		expect(isSafeUrlFieldValue(value)).toBe(false);
		expect(isSafeUrlFieldWriteValue(value)).toBe(false);
		expect(sanitizeHref(value)).toBe("#");
	});

	it.each(["/about", "/foo\\bar", "#contact", "https://example.com", "mailto:a@example.com"])(
		"keeps safe href %j",
		(value) => {
			expect(isSafeHref(value)).toBe(true);
			expect(isSafeUrlFieldWriteValue(value)).toBe(true);
			expect(sanitizeHref(value)).toBe(value);
		},
	);

	it("preserves scheme-less repository values that stay on-site", () => {
		expect(isSafeUrlFieldValue("www.example.com")).toBe(false);
		expect(isSafeUrlFieldWriteValue("www.example.com")).toBe(true);
	});
});
