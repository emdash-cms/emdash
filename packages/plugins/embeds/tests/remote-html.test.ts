import type { Server } from "node:http";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import Bluesky from "../src/astro/Bluesky.astro";
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

	describe("Bluesky", () => {
		const postUrl = "https://bsky.app/profile/alice.bsky.social/post/3juwcxjcku52k";

		async function renderBluesky(id: unknown) {
			const container = await AstroContainer.create();
			return container.renderToString(Bluesky, {
				props: { node: { _type: "bluesky", _key: "b", id } },
			});
		}

		it("renders the post HTML from Bluesky's oEmbed endpoint", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () =>
					Response.json({ html: '<blockquote class="bluesky-embed">post</blockquote>' }),
				);
			try {
				const html = await renderBluesky(postUrl);
				expect(html).toContain('<blockquote class="bluesky-embed">post</blockquote>');
				expect(fetchSpy).toHaveBeenCalledWith(
					`https://embed.bsky.app/oembed?url=${encodeURIComponent(postUrl)}&format=json`,
					expect.anything(),
				);
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it("keeps only the quote markup from the oEmbed HTML and loads Bluesky's embed script", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
				Response.json({
					html: `<blockquote class="bluesky-embed" data-bluesky-uri="at://did:plc:a/app.bsky.feed.post/b" data-bluesky-cid="bafy" data-bluesky-embed-color-mode="dark" onclick="alert(0)"><p lang="en">post</p>${XSS}</blockquote><script src="https://attacker.example/x.js"></script>`,
				}),
			);
			try {
				const html = await renderBluesky(postUrl);
				expect(html).toContain(
					'<blockquote class="bluesky-embed" data-bluesky-uri="at://did:plc:a/app.bsky.feed.post/b" data-bluesky-cid="bafy" data-bluesky-embed-color-mode="dark"><p lang="en">post</p>',
				);
				const embedScript =
					'<script async src="https://embed.bsky.app/static/embed.js" charset="utf-8"></script>';
				expect(html.split(embedScript)).toHaveLength(2);
				expectInert(html.replace(embedScript, ""));
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it.each([
			["the endpoint returns an error", async () => new Response("nope", { status: 404 })],
			["the endpoint returns no HTML", async () => Response.json({ html: 42 })],
			[
				"the request fails",
				async () => {
					throw new TypeError("network down");
				},
			],
		])("links to the post when %s", async (_label, impl) => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(impl);
			try {
				const html = await renderBluesky(postUrl);
				expect(html).toContain(`<a href="${postUrl}">`);
				expect(html).not.toContain("<blockquote");
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it("links to the post when the endpoint does not answer within five seconds", async () => {
			vi.useFakeTimers();
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			);
			try {
				const rendering = renderBluesky(postUrl);
				await vi.advanceTimersByTimeAsync(5000);
				const html = await rendering;
				expect(html).toContain(`<a href="${postUrl}">`);
			} finally {
				fetchSpy.mockRestore();
				vi.useRealTimers();
			}
		});

		it("does not fetch or render a URL outside bsky.app", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			try {
				const html = await renderBluesky("https://example.com/profile/a/post/b");
				expect(fetchSpy).not.toHaveBeenCalled();
				expect(html).not.toContain("example.com");
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it("skips a non-string post id without failing the render", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			try {
				const html = await renderBluesky(42);
				expect(fetchSpy).not.toHaveBeenCalled();
				expect(html).not.toContain("42");
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it("warns when the oEmbed request fails", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(new TypeError("network down"));
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await renderBluesky(postUrl);
				expect(warn).toHaveBeenCalledWith("[plugin-embeds] Bluesky oEmbed request failed");
			} finally {
				fetchSpy.mockRestore();
				warn.mockRestore();
			}
		});
	});

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
