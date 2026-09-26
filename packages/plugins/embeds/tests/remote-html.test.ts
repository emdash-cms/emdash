import type { Server } from "node:http";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import Gist from "../src/astro/Gist.astro";
import Mastodon from "../src/astro/Mastodon.astro";
import { sanitizeMastodonEmbed } from "../src/sanitize-mastodon.js";
import { startMaliciousServer, XSS } from "./malicious-remote.js";

let server: Server;
let origin: string;

beforeAll(async () => {
	({ server, origin } = await startMaliciousServer());
});

afterAll(() => {
	server.close();
});

function expectInert(html: string) {
	expect(html).not.toMatch(/<script/i);
	expect(html).not.toMatch(/\son[a-z]+=/i);
	expect(html).not.toMatch(/javascript:/i);
}

describe("embeds that render remote HTML", () => {
	it("does not render a gist from a host other than gist.github.com", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Gist, {
			props: { node: { _type: "gist", _key: "g", id: `${origin}/gist` } },
		});
		expectInert(html);
		expect(html).not.toContain("attacker.example");
	});

	it.each([
		"https://gist.github.com/some-user/9b6c6d9d1f1c",
		"https://gist.github.com/9b6c6d9d1f1d",
		"https://gist.github.com/some-user/9b6c6d9d1f1e?file=a.ts",
		"https://gist.github.com/some-user/9b6c6d9d1f1f#file-a-ts",
	])("renders the gist page URL %s", async (id) => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({ div: "<p>gist body</p>" }));
		try {
			const container = await AstroContainer.create();
			const html = await container.renderToString(Gist, {
				props: { node: { _type: "gist", _key: "g", id } },
			});
			expect(html).toContain("<p>gist body</p>");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it.each(["https://gist.github.com/u/abc123/raw/x", "https://gist.github.com/raw/abc123"])(
		"does not render %s, which redirects to a raw file",
		async (id) => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => Response.json({ div: XSS }));
			try {
				const container = await AstroContainer.create();
				const html = await container.renderToString(Gist, {
					props: { node: { _type: "gist", _key: "g", id } },
				});
				expectInert(html);
			} finally {
				fetchSpy.mockRestore();
			}
		},
	);

	it("strips scripts and event handlers from a Mastodon post", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Mastodon, {
			props: { node: { _type: "mastodon", _key: "m", id: `${origin}/@m/123` } },
		});
		expectInert(html);
		expect(html).not.toContain("attacker.example");
		expect(html).toContain('<template shadowrootmode="open"><link rel="stylesheet"');
		expect(html).toContain('part="user-display-name">Mallory');
		expect(html).toContain('<a href="https://example.com/ok">ok</a>');
		expect(html).toContain('src="https://example.com/a.png"');
	});

	it("keeps Mastodon post HTML inside the embed's shadow root", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Mastodon, {
			props: { node: { _type: "mastodon", _key: "m", id: `${origin}/@m/123` } },
		});
		expect(html.match(/<\/template>/g)).toHaveLength(1);
		expect(html.match(/<\/astro-embed-mastodon>/g)).toHaveLength(1);
		expect(html.indexOf("phish")).toBeLessThan(html.indexOf("</template>"));
	});

	it("sanitizes Mastodon markup rendered with whitespace between the wrapper tags", () => {
		const html = sanitizeMastodonEmbed(
			`<astro-embed-mastodon>\n\t<template shadowrootmode="open">\n\t\t<p>hi ${XSS}</p>\n\t</template>\n</astro-embed-mastodon>`,
		);
		expect(html).toContain("<p>hi ");
		expectInert(html);
	});

	it("renders nothing for markup that is not a Mastodon embed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(sanitizeMastodonEmbed(`<div>${XSS}</div>`)).toBe("");
		} finally {
			warn.mockRestore();
		}
	});
});
