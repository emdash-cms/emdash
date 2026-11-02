import sanitizeHtml from "sanitize-html";
import { describe, expect, it } from "vitest";

import { sanitizeContent } from "../../../src/utils/sanitize.js";

describe("sanitizeContent", () => {
	it("keeps YouTube and Vimeo iframes", () => {
		const youtube = '<iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe>';
		const vimeo = '<iframe src="https://player.vimeo.com/video/123"></iframe>';

		expect(sanitizeContent(youtube)).toBe(
			'<iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe>',
		);
		expect(sanitizeContent(vimeo)).toBe(
			'<iframe src="https://player.vimeo.com/video/123"></iframe>',
		);
	});

	it("removes the source of iframes from other hosts", () => {
		expect(sanitizeContent('<iframe src="https://evil.example/"></iframe>')).toBe(
			"<iframe></iframe>",
		);
	});

	it("keeps class, id and data attributes", () => {
		const html = '<div class="card" id="intro" data-role="note"><p>Hello</p></div>';

		expect(sanitizeContent(html)).toBe(html);
	});

	it("strips scripts, style elements, style attributes and event handlers", () => {
		const html =
			'<style>p{color:red}</style><p style="color:red" onclick="steal()">Hi</p><script>steal()</script><img src="/a.png" onerror="steal()">';

		expect(sanitizeContent(html)).toBe('<p>Hi</p><img src="/a.png" />');
	});

	it("keeps link targets and image attributes", () => {
		const html =
			'<a href="https://example.com" target="_blank" name="x">Go</a><img src="/a.png" alt="A" width="10" loading="lazy" />';

		expect(sanitizeContent(html)).toBe(html);
	});

	it("drops disallowed schemes and attributes but keeps disallowed tags' text", () => {
		const html =
			'<img src="data:image/png;base64,AA" alt="x"><iframe src="//www.youtube.com/embed/abc"></iframe><table width="100%"><tbody><tr><td width="50">Cell</td></tr></tbody></table><video>Fallback</video><textarea>Hidden</textarea><a href="javascript:alert(1)">Link</a>';

		expect(sanitizeContent(html)).toBe(
			'<img alt="x" /><iframe src="//www.youtube.com/embed/abc"></iframe><table><tbody><tr><td>Cell</td></tr></tbody></table>Fallback<a>Link</a>',
		);
	});

	it("keeps and removes the same markup as sanitize-html's defaults", () => {
		const html =
			'<h2 id="a" class="b">Title</h2><p>Text <strong>bold</strong> <a href="https://example.com/" target="_blank">link</a> <a href="javascript:alert(1)">bad</a> <a href="mailto:a@example.com">mail</a></p>' +
			'<ul><li>One</li></ul><table><tbody><tr><td>Cell</td></tr></tbody></table><span data-id="1">Span</span>' +
			'<img src="https://example.com/a.png" alt="A" loading="lazy"><img src="data:image/png;base64,AA" alt="B">' +
			'<iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe><iframe src="https://evil.example/"></iframe>' +
			'<video src="https://example.com/v.mp4">Video</video><audio>Audio</audio><form><input value="x"><button>Go</button></form>' +
			"<canvas>Canvas</canvas><details><summary>More</summary>Body</details>" +
			'<p style="color: red" onclick="steal()">Handlers</p><script>steal()</script><style>p { color: red; }</style>';
		const defaults = sanitizeHtml(html, {
			allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "span", "iframe"],
			allowedAttributes: {
				...sanitizeHtml.defaults.allowedAttributes,
				"*": ["class", "id", "data-*"],
				iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen"],
				img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
			},
			allowedIframeHostnames: ["www.youtube.com", "player.vimeo.com"],
		});

		expect(sanitizeContent(html)).toBe(defaults);
	});
});
