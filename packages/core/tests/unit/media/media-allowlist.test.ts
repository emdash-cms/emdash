import { describe, it, expect } from "vitest";

import { GLOBAL_UPLOAD_ALLOWLIST } from "../../../src/api/handlers/media-allowlist.js";
import { matchesMimeAllowlist } from "../../../src/media/mime.js";

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

	it("still allows video, audio, and pdf", () => {
		expect(matchesMimeAllowlist("video/mp4", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
		expect(matchesMimeAllowlist("audio/mpeg", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
		expect(matchesMimeAllowlist("application/pdf", GLOBAL_UPLOAD_ALLOWLIST)).toBe(true);
	});
});
