import { describe, it, expect } from "vitest";

import { contentDisposition, toAsciiFilename } from "../../src/media/content-disposition.js";

describe("toAsciiFilename", () => {
	it("passes an ordinary filename through unchanged", () => {
		expect(toAsciiFilename("family-guide-2026.pdf")).toBe("family-guide-2026.pdf");
	});

	it("replaces path separators and reserved characters", () => {
		expect(toAsciiFilename("a/b\\c:d*e?f.pdf")).toBe("a-b-c-d-e-f.pdf");
	});

	it("strips quotes so the value cannot break out of the quoted parameter", () => {
		expect(toAsciiFilename('evil".pdf')).toBe("evil-.pdf");
	});

	it("drops non-ASCII characters, which filename* carries instead", () => {
		// NFKD decomposition leaves the base letter and drops the accent.
		expect(toAsciiFilename("rapport-été.pdf")).toBe("rapport-ete.pdf");
	});

	it("falls back to a placeholder when nothing printable remains", () => {
		expect(toAsciiFilename("日本語")).toBe("download");
	});
});

describe("contentDisposition", () => {
	it("returns the bare disposition when no filename is known", () => {
		expect(contentDisposition("attachment", null)).toBe("attachment");
		expect(contentDisposition("attachment", "")).toBe("attachment");
		expect(contentDisposition("inline", undefined)).toBe("inline");
	});

	it("emits both filename and RFC 5987 filename*", () => {
		expect(contentDisposition("attachment", "family-guide.pdf")).toBe(
			`attachment; filename="family-guide.pdf"; filename*=UTF-8''family-guide.pdf`,
		);
	});

	it("percent-encodes the UTF-8 form for a non-ASCII name", () => {
		const value = contentDisposition("attachment", "日本語.pdf");
		expect(value).toContain(`filename=".pdf"`);
		expect(value).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf");
	});

	it("does not let a filename inject extra header parameters", () => {
		const value = contentDisposition("attachment", 'x"; filename="evil.exe');
		expect(value).toBe(
			`attachment; filename="x-; filename=-evil.exe"; filename*=UTF-8''x%22%3B%20filename%3D%22evil.exe`,
		);
	});
});
