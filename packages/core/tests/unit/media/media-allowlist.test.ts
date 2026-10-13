import { describe, it, expect } from "vitest";

import { GLOBAL_UPLOAD_ALLOWLIST } from "../../../src/api/handlers/media-allowlist.js";
import { expandExtensionShorthand, matchesMimeAllowlist } from "../../../src/media/mime.js";

describe("GLOBAL_UPLOAD_ALLOWLIST", () => {
	it("rejects image/svg+xml (no upload-time content validation exists for SVG scripts)", () => {
		expect(matchesMimeAllowlist("image/svg+xml", GLOBAL_UPLOAD_ALLOWLIST)).toBe(false);
	});

	it("still allows common raster image types", () => {
		expect(matchesMimeAllowlist("image/png", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
		expect(matchesMimeAllowlist("image/jpeg", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
		expect(matchesMimeAllowlist("image/gif", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
		expect(matchesMimeAllowlist("image/webp", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
	});

	it("allows image/avif, which the media routes already serve inline", () => {
		expect(matchesMimeAllowlist("image/avif", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
	});

	it("allows image/jxl (JPEG XL) for uploads", () => {
		expect(matchesMimeAllowlist("image/jxl", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
	});

	it("still allows video, audio, and pdf", () => {
		expect(matchesMimeAllowlist("video/mp4", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
		expect(matchesMimeAllowlist("audio/mpeg", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
		expect(matchesMimeAllowlist("application/pdf", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
	});
});

describe("EXTENSION_TO_MIME", () => {
	it("resolves .jxl to image/jxl", () => {
		expect(expandExtensionShorthand(".jxl")).toBe("image/jxl");
	});
});
