import { describe, expect, it } from "vitest";

import { extractPlainText } from "../../../src/search/text-extraction.js";

describe("extractPlainText", () => {
	it("includes video captions", () => {
		const text = extractPlainText([
			{
				_type: "video",
				_key: "video1",
				asset: { _ref: "01VIDEO" },
				caption: "Keynote recording",
			},
		]);

		expect(text).toBe("Keynote recording");
	});

	it("leaves the caption of a plugin's video block alone", () => {
		const text = extractPlainText([
			{
				_type: "video",
				_key: "video1",
				asset: { _ref: "01VIDEO" },
				autoplay: true,
				caption: "Internal note",
			},
		]);

		expect(text).toBe("");
	});
});
