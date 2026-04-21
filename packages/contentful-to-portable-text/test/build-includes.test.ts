/**
 * Tests for the buildIncludes() utility.
 */

import { describe, it, expect } from "vitest";

import { buildIncludes } from "../src/index.js";
import fixture from "./fixtures/contentful-blogpost.json";

describe("buildIncludes", () => {
	it("builds entries Map from includes.Entry[] with id → { id, contentType, fields }", () => {
		const includes = buildIncludes({
			Entry: fixture.items as Array<Record<string, unknown>>,
		});

		// Fixture has 13 items total
		expect(includes.entries.size).toBe(13);

		// Check a specific entry (blogCodeBlock)
		const codeBlock = includes.entries.get("code-block-1");
		expect(codeBlock).toBeDefined();
		expect(codeBlock!.id).toBe("code-block-1");
		expect(codeBlock!.contentType).toBe("blogCodeBlock");
		expect(codeBlock!.fields).toBeDefined();
		expect(typeof codeBlock!.fields.code).toBe("string");
	});

	it("builds assets Map from includes.Asset[] with id → { id, title, description, url, width, height, contentType }", () => {
		const includes = buildIncludes({
			Asset: (fixture.includes?.Asset ?? []) as Array<Record<string, unknown>>,
		});

		expect(includes.assets.size).toBe(1);

		const asset = includes.assets.get("asset-1");
		expect(asset).toBeDefined();
		expect(asset!.id).toBe("asset-1");
		expect(asset!.title).toBe("Architecture diagram");
		expect(asset!.description).toBe("A diagram showing the migration pipeline architecture");
		expect(asset!.url).toBe(
			"//images.ctfassets.net/test-space/asset-1/abc123/architecture-diagram.png",
		);
		expect(asset!.width).toBe(1200);
		expect(asset!.height).toBe(800);
		expect(asset!.contentType).toBe("image/png");
	});

	it("empty/missing includes → empty Maps (no crash)", () => {
		const includes1 = buildIncludes({});
		expect(includes1.entries.size).toBe(0);
		expect(includes1.assets.size).toBe(0);

		const includes2 = buildIncludes({ Entry: [], Asset: [] });
		expect(includes2.entries.size).toBe(0);
		expect(includes2.assets.size).toBe(0);
	});

	it("asset file URL and dimensions extracted from fields.file.url and fields.file.details.image", () => {
		const includes = buildIncludes({
			Asset: [
				{
					sys: { id: "test-asset" },
					fields: {
						title: "Test Image",
						description: "A test image",
						file: {
							url: "//images.ctfassets.net/test.png",
							contentType: "image/png",
							details: {
								size: 12345,
								image: {
									width: 800,
									height: 600,
								},
							},
						},
					},
				},
			],
		});

		const asset = includes.assets.get("test-asset");
		expect(asset).toBeDefined();
		expect(asset!.url).toBe("//images.ctfassets.net/test.png");
		expect(asset!.width).toBe(800);
		expect(asset!.height).toBe(600);
		expect(asset!.contentType).toBe("image/png");
		expect(asset!.title).toBe("Test Image");
		expect(asset!.description).toBe("A test image");
	});

	it("entries without contentType → contentType defaults to 'unknown'", () => {
		const includes = buildIncludes({
			Entry: [
				{
					sys: { id: "no-ct" },
					fields: { name: "test" },
				},
			],
		});

		const entry = includes.entries.get("no-ct");
		expect(entry).toBeDefined();
		expect(entry!.contentType).toBe("unknown");
	});

	it("assets without file → url defaults to empty string, dimensions undefined", () => {
		const includes = buildIncludes({
			Asset: [
				{
					sys: { id: "no-file-asset" },
					fields: { title: "No File" },
				},
			],
		});

		const asset = includes.assets.get("no-file-asset");
		expect(asset).toBeDefined();
		expect(asset!.url).toBe("");
		expect(asset!.width).toBeUndefined();
		expect(asset!.height).toBeUndefined();
	});
});
