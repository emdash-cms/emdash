import { describe, expect, it } from "vitest";

import {
	isSafeHref,
	isSafeMediaUrl,
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

	it.each([
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		" javascript:alert(1)",
		"\tjava\nscript:alert(1)",
		"\u0000javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox(1)",
		"blob:https://example.com/0f0e",
		"mailto:a@example.com",
	])("rejects media URL %j", (value) => {
		expect(isSafeMediaUrl(value)).toBe(false);
	});

	it.each([
		"https://cdn.example/photo.jpg",
		"HTTP://cdn.example/photo.jpg",
		"/_emdash/api/media/file/photo.jpg",
		"images/photo.jpg",
		"//cdn.example/photo.jpg",
		"01JAB2C3D4E5F6G7H8J9K0MNPQ",
		"photo.jpg?size=1:1",
	])("keeps media URL %j", (value) => {
		expect(isSafeMediaUrl(value)).toBe(true);
	});

	it.each([
		'["javascript:alert(1)"]',
		' ["javascript:alert(1)"]',
		'{"href":"javascript:alert(1)"}',
	])("rejects repository text %j that reads back as JSON", (value) => {
		expect(isSafeUrlFieldValue(value)).toBe(false);
		expect(isSafeUrlFieldWriteValue(value)).toBe(false);
	});

	it.each([[["javascript:alert(1)"]], [{ href: "/about" }], [1], [true]])(
		"rejects repository value %j that is not a string",
		(value) => {
			expect(isSafeUrlFieldWriteValue(value)).toBe(false);
		},
	);
});
