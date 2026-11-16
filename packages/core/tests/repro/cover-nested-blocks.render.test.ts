import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Cover from "../../src/components/Cover.astro";

describe("Cover rendering", () => {
	it("renders buttons and images inside a cover, not only its text", async () => {
		const node = {
			_type: "cover",
			_key: "cover",
			backgroundImage: "https://example.com/hall.jpg",
			content: [
				{
					_type: "block",
					_key: "heading",
					style: "h2",
					markDefs: [],
					children: [{ _type: "span", _key: "span", text: "Evening tours", marks: [] }],
				},
				{
					_type: "image",
					_key: "logo",
					asset: { _ref: "logo", url: "https://example.com/logo.png" },
					alt: "Museum logo",
				},
				{
					_type: "buttons",
					_key: "buttons",
					buttons: [
						{
							_type: "button",
							_key: "book",
							text: "Book a tour",
							url: "https://example.com/tours",
						},
					],
				},
			],
		};

		const container = await AstroContainer.create();
		const html = await container.renderToString(Cover, { props: { node } });

		expect(html).toContain("Evening tours");
		expect(html).toMatch(/<img[^>]+alt="Museum logo"/);
		expect(html).toMatch(/<a[^>]+href="https:\/\/example\.com\/tours"[^>]*>\s*Book a tour/);
	});
});
