import { describe, expect, it } from "vitest";

import { iframeEmbedToCode, parseIframeInput } from "../../src/components/editor/iframe-embed";

describe("parseIframeInput", () => {
	it("accepts YouTube's own share code", () => {
		const code =
			'<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';

		expect(parseIframeInput(code)).toEqual({
			ok: true,
			embed: {
				src: "https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc",
				title: "YouTube video player",
				width: 560,
				height: 315,
				allow:
					"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
				allowFullscreen: true,
			},
		});
	});

	it("turns YouTube links into the player", () => {
		for (const link of [
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://youtu.be/dQw4w9WgXcQ",
			"https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
			"https://www.youtube.com/shorts/dQw4w9WgXcQ",
		]) {
			const result = parseIframeInput(link);
			expect(result.ok && result.embed?.src).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
		}
	});

	it("doesn't cut a longer YouTube path down to a video ID", () => {
		const link = "https://www.youtube.com/shorts/dQw4w9WgXcQextra";

		expect(parseIframeInput(link)).toEqual({ ok: true, embed: { src: link } });
	});

	it("turns a Vimeo link into the player", () => {
		const result = parseIframeInput("https://vimeo.com/76979871");

		expect(result).toMatchObject({
			ok: true,
			embed: { src: "https://player.vimeo.com/video/76979871", allowFullscreen: true },
		});
	});

	it("keeps any other https URL", () => {
		expect(parseIframeInput("  https://maps.example.com/embed?pb=1  ")).toEqual({
			ok: true,
			embed: { src: "https://maps.example.com/embed?pb=1" },
		});
	});

	it("rejects sources that aren't https and code without an iframe", () => {
		expect(parseIframeInput("http://example.com/")).toEqual({ ok: false, reason: "not-https" });
		expect(parseIframeInput("javascript:alert(1)")).toEqual({ ok: false, reason: "not-https" });
		expect(parseIframeInput("/embed/relative")).toEqual({ ok: false, reason: "not-https" });
		expect(parseIframeInput('<iframe src="/embed"></iframe>')).toEqual({
			ok: false,
			reason: "not-https",
		});
		expect(parseIframeInput("<div>No frame</div>")).toEqual({ ok: false, reason: "no-iframe" });
	});

	it("clears the embed for blank text", () => {
		expect(parseIframeInput("   \n")).toEqual({ ok: true, embed: null });
	});

	it("drops a permission whose allowlist is 'none'", () => {
		const result = parseIframeInput(
			'<iframe src="https://example.com/" allow="autoplay \'none\'; fullscreen"></iframe>',
		);

		expect(result).toMatchObject({ ok: true, embed: { allow: "fullscreen" } });
	});

	it("ignores percentage sizes and permissions players don't need", () => {
		const result = parseIframeInput(
			'<iframe src="https://example.com/" width="100%" height="480" allow="camera; microphone; fullscreen"></iframe>',
		);

		expect(result).toEqual({
			ok: true,
			embed: { src: "https://example.com/", height: 480, allow: "fullscreen" },
		});
	});
});

describe("iframeEmbedToCode", () => {
	it("writes an embed code that parses back to the same embed", () => {
		const embed = {
			src: "https://example.com/?a=1&b=2",
			title: 'Map "north"',
			width: 640,
			height: 480,
			allow: "fullscreen",
			allowFullscreen: true,
		};

		expect(parseIframeInput(iframeEmbedToCode(embed))).toEqual({ ok: true, embed });
	});
});
