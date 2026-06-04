import { describe, expect, it } from "vitest";

import {
	extractSbom,
	presentSections,
	sbomDownloadHref,
	SECTION_ORDER,
} from "../../src/lib/api/registry";

describe("presentSections", () => {
	it("returns nothing for a missing or non-object sections map", () => {
		expect(presentSections(null)).toEqual([]);
		expect(presentSections(undefined)).toEqual([]);
		expect(presentSections({})).toEqual([]);
		expect(presentSections({ sections: undefined })).toEqual([]);
		expect(presentSections({ sections: "nope" })).toEqual([]);
	});

	it("keeps non-empty sections in SECTION_ORDER", () => {
		const result = presentSections({
			sections: {
				// Deliberately out of display order to prove ordering is by SECTION_ORDER.
				security: "Report issues to security@example.com",
				description: "# Hello\n\nA plugin.",
				installation: "Run `npm i`.",
			},
		});
		expect(result.map((s) => s.key)).toEqual(["description", "installation", "security"]);
		expect(result[0]!.markdown).toBe("# Hello\n\nA plugin.");
	});

	it("drops empty, whitespace-only, and non-string entries", () => {
		const result = presentSections({
			sections: {
				description: "Real content",
				installation: "",
				faq: "   \n\t  ",
				changelog: 42,
				security: null,
			},
		});
		expect(result.map((s) => s.key)).toEqual(["description"]);
	});

	it("ignores unrecognised section keys", () => {
		const result = presentSections({
			sections: { description: "ok", "x-custom": "should be ignored" },
		});
		expect(result.map((s) => s.key)).toEqual(["description"]);
	});

	it("covers every key in SECTION_ORDER when all are present", () => {
		const sections = Object.fromEntries(SECTION_ORDER.map((k) => [k, `content for ${k}`]));
		const result = presentSections({ sections });
		expect(result.map((s) => s.key)).toEqual([...SECTION_ORDER]);
	});
});

describe("extractSbom", () => {
	it("returns null for non-object or fully-empty input", () => {
		expect(extractSbom(undefined)).toBeNull();
		expect(extractSbom(null)).toBeNull();
		expect(extractSbom("nope")).toBeNull();
		expect(extractSbom({})).toBeNull();
		expect(extractSbom({ format: "", url: "" })).toBeNull();
		expect(extractSbom({ checksum: "bafy..." })).toBeNull();
	});

	it("keeps a url with no format", () => {
		expect(extractSbom({ url: "https://x/sbom.json" })).toEqual({ url: "https://x/sbom.json" });
	});

	it("extracts format, url, and checksum", () => {
		expect(
			extractSbom({
				format: "cyclonedx",
				url: "https://x/sbom.json",
				checksum: "bafy...",
			}),
		).toEqual({ format: "cyclonedx", url: "https://x/sbom.json", checksum: "bafy..." });
	});

	it("keeps a format with no url", () => {
		expect(extractSbom({ format: "spdx" })).toEqual({ format: "spdx" });
	});
});

describe("sbomDownloadHref", () => {
	it("accepts http(s) URLs", () => {
		expect(sbomDownloadHref("https://x/sbom.json")).toBe("https://x/sbom.json");
		expect(sbomDownloadHref("http://x/sbom.json")).toBe("http://x/sbom.json");
	});

	it("rejects non-http(s) schemes and garbage", () => {
		expect(sbomDownloadHref("javascript:alert(1)")).toBeNull();
		expect(sbomDownloadHref("data:text/html,<script>")).toBeNull();
		expect(sbomDownloadHref("/relative/path")).toBeNull();
		expect(sbomDownloadHref("not a url")).toBeNull();
		expect(sbomDownloadHref("")).toBeNull();
		expect(sbomDownloadHref(undefined)).toBeNull();
		expect(sbomDownloadHref(123)).toBeNull();
	});
});
