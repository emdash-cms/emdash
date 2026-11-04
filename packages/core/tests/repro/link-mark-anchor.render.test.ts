/**
 * Same-page anchor links (`#section`) must never open in a new tab, even when
 * the stored link mark has `blank: true`. Opening an on-page jump in a new tab
 * is never desirable — it should stay in the same tab (`_self`).
 *
 * Regression: external links with `blank: true` must still open in a new tab.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import Link from "../../src/components/marks/Link.astro";

const anchorTag = (html: string) => html.match(/<a\b[^>]*>/)?.[0] ?? "";

async function renderLink(markDef: Record<string, unknown>) {
	const c = await AstroContainer.create();
	return c.renderToString(Link, {
		props: { node: { markDef } },
		slots: { default: "jump" },
	});
}

describe("Link mark: same-page anchor target handling", () => {
	test("same-page anchor with blank=true stays in same tab", async () => {
		const html = await renderLink({
			_type: "link",
			_key: "k1",
			href: "#section",
			blank: true,
		});
		const tag = anchorTag(html);
		expect(tag).toContain('href="#section"');
		expect(tag).not.toContain('target="_blank"');
		expect(tag).not.toContain("noopener");
	});

	test("external link with blank=true still opens in new tab", async () => {
		const html = await renderLink({
			_type: "link",
			_key: "k2",
			href: "https://example.com",
			blank: true,
		});
		const tag = anchorTag(html);
		expect(tag).toContain('href="https://example.com"');
		expect(tag).toContain('target="_blank"');
		expect(tag).toContain("noopener");
	});

	test("same-page anchor without blank stays in same tab", async () => {
		const html = await renderLink({
			_type: "link",
			_key: "k3",
			href: "#top",
			blank: false,
		});
		const tag = anchorTag(html);
		expect(tag).toContain('href="#top"');
		expect(tag).not.toContain('target="_blank"');
	});
});
