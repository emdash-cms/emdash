/**
 * Block and image fields that reach an inline `style` attribute are stored as
 * the author sent them. A value that is not a single color, length or number
 * must not be rendered, or it adds CSS declarations of its own to the page.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Columns from "../../src/components/Columns.astro";
import Cover from "../../src/components/Cover.astro";
import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";
import Image from "../../src/components/Image.astro";

const EXTRA_DECLARATION = ";outline:1px solid red";

const locals = {
	emdash: { getPublicMediaUrl: (key: string) => `/_emdash/api/media/file/${key}` },
};

const styles = (html: string) =>
	Array.from(html.matchAll(/\bstyle="([^"]*)"/g), (match) => match[1] ?? "");

async function render(component: Parameters<AstroContainer["renderToString"]>[0], props: object) {
	const container = await AstroContainer.create();
	return container.renderToString(component, { props: { ...props }, locals });
}

const paragraph = {
	_type: "block",
	_key: "p",
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: "s", text: "Text", marks: [] }],
};

describe("stored values in inline styles", () => {
	it("renders an image block's dominant color as its placeholder", async () => {
		const html = await render(Image, {
			node: {
				_type: "image",
				_key: "i",
				asset: { _ref: "", url: "/_emdash/api/media/file/photo.png" },
				dominantColor: "rgb(51,102,153)",
			},
		});

		expect(styles(html)).toEqual(["background-color: rgb(51,102,153);"]);
	});

	it("drops an image block's dominant color that is not a color", async () => {
		for (const node of [
			{ dominantColor: `transparent${EXTRA_DECLARATION}` },
			{
				asset: {
					_ref: "",
					url: "/photo.png",
					meta: { dominantColor: `#336699${EXTRA_DECLARATION}` },
				},
			},
		]) {
			const html = await render(Image, {
				node: {
					_type: "image",
					_key: "i",
					asset: { _ref: "", url: "/_emdash/api/media/file/photo.png" },
					link: "https://example.com/",
					...node,
				},
			});

			expect(html).toContain("<img");
			expect(styles(html)).toEqual([]);
		}
	});

	it("falls back to the asset's dominant color when the block's is not a color", async () => {
		const html = await render(Image, {
			node: {
				_type: "image",
				_key: "i",
				asset: {
					_ref: "",
					url: "/_emdash/api/media/file/photo.png",
					meta: { dominantColor: "rgb(51,102,153)" },
				},
				dominantColor: `transparent${EXTRA_DECLARATION}`,
			},
		});

		expect(styles(html)).toEqual(["background-color: rgb(51,102,153);"]);
	});

	it("falls back to an image field's meta dominant color when its own is not a color", async () => {
		const html = await render(EmDashImage, {
			image: {
				provider: "external",
				id: "x",
				src: "https://example.com/photo.jpg",
				dominantColor: `transparent${EXTRA_DECLARATION}`,
				meta: { dominantColor: "#336699" },
			},
		});

		expect(styles(html)).toEqual(["background-color: #336699;"]);
	});

	it("drops an image field's dominant color that is not a color", async () => {
		const image = { provider: "external", id: "x", src: "https://example.com/photo.jpg" };

		const kept = await render(EmDashImage, { image: { ...image, dominantColor: "#336699" } });
		expect(styles(kept)).toEqual(["background-color: #336699;"]);

		for (const value of [
			{ dominantColor: `transparent${EXTRA_DECLARATION}` },
			{ meta: { dominantColor: `transparent${EXTRA_DECLARATION}` } },
		]) {
			const html = await render(EmDashImage, { image: { ...image, ...value } });

			expect(html).toContain("<img");
			expect(styles(html)).toEqual([]);
		}
	});

	it("drops a gallery's column count and dominant colors that are not valid", async () => {
		const image = { _type: "image", asset: { _ref: "", url: "/_emdash/api/media/file/a.png" } };
		const html = await render(Gallery, {
			node: {
				_type: "gallery",
				_key: "g",
				columns: `2${EXTRA_DECLARATION}`,
				images: [
					{ ...image, _key: "a", dominantColor: "rgb(51,102,153)" },
					{ ...image, _key: "b", dominantColor: `transparent${EXTRA_DECLARATION}` },
				],
			},
		});

		expect(styles(html)).toEqual(["--columns: 3", "background-color: rgb(51,102,153);"]);
	});

	it("keeps a gallery's column count", async () => {
		const html = await render(Gallery, {
			node: {
				_type: "gallery",
				_key: "g",
				columns: 4,
				images: [{ _type: "image", _key: "a", asset: { _ref: "", url: "/a.png" } }],
			},
		});

		expect(styles(html)).toEqual(["--columns: 4"]);
	});

	it("renders a cover's overlay color, opacity and minimum height", async () => {
		const html = await render(Cover, {
			node: {
				_type: "cover",
				_key: "c",
				backgroundImage: "https://example.com/hall.jpg",
				overlayColor: "#112233",
				overlayOpacity: 0.3,
				minHeight: "50vh",
				content: [paragraph],
			},
		});

		expect(styles(html)).toEqual(["min-height: 50vh;", "background-color: #112233; opacity: 0.3;"]);
	});

	it("renders a cover's preset color name and numeric string opacity", async () => {
		const html = await render(Cover, {
			node: {
				_type: "cover",
				_key: "c",
				backgroundImage: "https://example.com/hall.jpg",
				overlayColor: "accent-1",
				overlayOpacity: "0.3",
				content: [paragraph],
			},
		});

		expect(styles(html)).toEqual([
			"min-height: 300px;",
			"background-color: accent-1; opacity: 0.3;",
		]);
	});

	it("falls back to a cover's defaults for values that are not valid", async () => {
		const html = await render(Cover, {
			node: {
				_type: "cover",
				_key: "c",
				backgroundImage: "https://example.com/hall.jpg",
				overlayColor: `#112233${EXTRA_DECLARATION}`,
				overlayOpacity: `0.3${EXTRA_DECLARATION}`,
				minHeight: `50vh${EXTRA_DECLARATION}`,
				content: [paragraph],
			},
		});

		expect(styles(html)).toEqual(["min-height: 300px;", "background-color: rgba(0, 0, 0, 0.5);"]);
	});

	it("drops a column width that is not a length", async () => {
		const html = await render(Columns, {
			node: {
				_type: "columns",
				_key: "c",
				columns: [
					{ _type: "column", _key: "a", width: "33.33%", content: [paragraph] },
					{ _type: "column", _key: "b", width: `66.66%${EXTRA_DECLARATION}`, content: [paragraph] },
				],
			},
		});

		expect(styles(html)).toEqual(["--column-count: 2", "flex-basis: 33.33%"]);
	});

	it("keeps single-value expressions in cover and column sizes and colors", async () => {
		const cover = await render(Cover, {
			node: {
				_type: "cover",
				_key: "c",
				backgroundImage: "https://example.com/hall.jpg",
				overlayColor: "var(--overlay, black)",
				overlayOpacity: "-0.1",
				minHeight: "calc(100vh - 4rem)",
				content: [paragraph],
			},
		});
		expect(styles(cover)).toEqual([
			"min-height: calc(100vh - 4rem);",
			"background-color: var(--overlay, black); opacity: 0;",
		]);

		const columns = await render(Columns, {
			node: {
				_type: "columns",
				_key: "c",
				columns: [
					{ _type: "column", _key: "a", width: "calc(50% - 1rem)", content: [paragraph] },
					{ _type: "column", _key: "b", width: ".5rem", content: [paragraph] },
				],
			},
		});
		expect(styles(columns)).toEqual([
			"--column-count: 2",
			"flex-basis: calc(50% - 1rem)",
			"flex-basis: .5rem",
		]);
	});
});
