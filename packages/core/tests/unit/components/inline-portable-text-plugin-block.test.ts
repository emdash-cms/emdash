// @vitest-environment jsdom

/**
 * Plugin-contributed and unknown block types can't be edited in the inline
 * editor. They show as placeholders and save with every field they loaded
 * with.
 */

import type { PortableTextBlock } from "@emdash-cms/admin/internal/portable-text";
import { afterEach, describe, expect, it } from "vitest";

import {
	destroyInlineEditors,
	loadInline,
	roundTripInline,
	saveInline,
} from "../../utils/inline-portable-text.js";

afterEach(destroyInlineEditors);

const paragraph = (key: string, text: string): PortableTextBlock => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
});

describe("inline editor plugin blocks", () => {
	it("shows each block it can't edit as a placeholder naming its type", () => {
		const editor = loadInline([
			{ _type: "marketing.hero", _key: "hero", headline: "Hi" },
			{ _type: "gallery", _key: "g", images: [] },
			{ _type: "video", _key: "v", url: "https://example.com/v.mp4" },
			{ _type: "iframe", _key: "i", src: "https://example.com" },
		]);

		const placeholders = editor.view.dom.querySelectorAll("[data-emdash-plugin-block]");
		expect(Array.from(placeholders, (node) => node.textContent)).toEqual([
			"Plugin block: marketing.hero (edit in admin)",
			"Plugin block: gallery (edit in admin)",
			"Plugin block: video (edit in admin)",
			"Plugin block: iframe (edit in admin)",
		]);
		expect(placeholders[0]?.getAttribute("contenteditable")).toBe("false");
	});

	it("saves a plugin block with nested fields unchanged", () => {
		const hero = {
			_type: "marketing.hero",
			_key: "hero",
			headline: "Build products people want",
			centered: true,
			primaryCta: { label: "Sign up", url: "/signup" },
			items: [{ question: "Q?", answer: "A." }],
		};

		expect(roundTripInline([hero])).toEqual([hero]);
	});

	it("keeps whichever of id and url a block has, and adds neither", () => {
		const blocks = [
			{ _type: "embed", _key: "url", url: "https://youtu.be/abc", provider: "youtube" },
			{ _type: "embed", _key: "both", id: "vid-1", url: "https://youtu.be/abc" },
			{ _type: "embed", _key: "number", id: 5 },
			{ _type: "marketing.hero", _key: "none", headline: "Hi" },
		];

		expect(roundTripInline(blocks)).toEqual(blocks);
	});

	it("keeps a plugin's own video and iframe fields", () => {
		const blocks = [
			{ _type: "video", _key: "v", provider: "vimeo", videoId: "123", autoplay: true },
			{ _type: "iframe", _key: "i", src: "https://example.com", sandbox: "allow-scripts" },
		];

		expect(roundTripInline(blocks)).toEqual(blocks);
	});

	it("saves a plugin block unchanged after an edit beside it", () => {
		const hero = { _type: "marketing.hero", _key: "hero", headline: "Hi" };
		const editor = loadInline([paragraph("p", "Before"), hero]);

		editor.commands.insertContentAt(1, "Edited ");

		const [edited, saved] = saveInline(editor);
		const children = (edited as { children: Array<{ text: string }> }).children;
		expect(children.map((span) => span.text).join("")).toBe("Edited Before");
		expect(saved).toEqual(hero);
	});
});
