/**
 * A `title` stored on a link markDef must reach the rendered `<a>` so the
 * browser shows it on hover. The editor round-trip already preserves extra
 * markDef fields; only the renderer dropped it.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import Link from "../../src/components/marks/Link.astro";

const anchorTag = (html: string) => html.match(/<a\b[^>]*>/)?.[0] ?? "";

async function renderLink(markDef: Record<string, unknown>) {
	const c = await AstroContainer.create();
	return c.renderToString(Link, {
		props: { node: { markDef } },
		slots: { default: "John 3:16" },
	});
}

describe("Link mark: title attribute", () => {
	test("renders a string title", async () => {
		const tag = anchorTag(
			await renderLink({
				_type: "link",
				_key: "t1",
				href: "https://example.com",
				title: "For God so loved the world",
			}),
		);
		expect(tag).toContain('title="For God so loved the world"');
	});

	test("escapes the title", async () => {
		const tag = anchorTag(
			await renderLink({
				_type: "link",
				_key: "t2",
				href: "https://example.com",
				title: '"><script>alert(1)</script>',
			}),
		);
		expect(tag).not.toContain("<script>");
		expect(tag).toContain("title=");
	});

	test("omits missing, blank, or non-string titles", async () => {
		for (const title of [undefined, "", "   ", 42, { x: 1 }]) {
			const tag = anchorTag(
				await renderLink({ _type: "link", _key: "t3", href: "https://example.com", title }),
			);
			expect(tag).not.toContain("title=");
		}
	});
});
