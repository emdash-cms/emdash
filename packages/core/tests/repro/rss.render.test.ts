import { getEmDashCollection, getSiteSettings } from "emdash";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as cloudflareGET } from "../../../../demos/cloudflare/src/pages/rss.xml.js";
import { GET as simpleGET } from "../../../../demos/simple/src/pages/rss.xml.js";
import { GET as templateGET } from "../../../../templates/blog-cloudflare/src/pages/rss.xml.js";
import { absoluteFeedUrls, cdata } from "../../../../templates/blog-cloudflare/src/utils/rss.js";
import { getRequestContext, runWithContext } from "../../src/request-context.js";

vi.mock("emdash", async () => ({
	...(await import("../../src/request-context.js")),
	getEmDashCollection: vi.fn(),
	getSiteSettings: vi.fn(),
	getI18nConfig: () => undefined,
}));

const baseUrl = "https://blog.example.com";
const block = (text: string, style = "normal") => ({
	_type: "block",
	_key: text,
	style,
	markDefs: [],
	children: [{ _type: "span", _key: "text", text, marks: [] }],
});
const post = () => ({
	id: "full-post",
	data: {
		title: "A & B",
		excerpt: "Short <summary>",
		publishedAt: new Date("2026-10-20T12:00:00Z"),
		content: [
			block("Full heading", "h2"),
			block("Full body, beyond the summary."),
			{ _type: "code", _key: "code", code: "const value = 1;", language: "js" },
			{
				_type: "image",
				_key: "image",
				asset: { _ref: "cover", url: "/_emdash/api/media/file/cover.jpg" },
				alt: "Cover",
			},
		],
	},
});

beforeEach(() => {
	vi.mocked(getSiteSettings).mockResolvedValue({ title: "My blog", tagline: "Writing" });
	vi.mocked(getEmDashCollection).mockResolvedValue({ entries: [post()], cacheHint: {} } as Awaited<
		ReturnType<typeof getEmDashCollection>
	>);
});

describe.each([
	{ name: "Cloudflare template", getFeed: templateGET },
	{ name: "Cloudflare demo", getFeed: cloudflareGET },
	{ name: "local preview", getFeed: simpleGET },
])("full-content RSS ($name)", ({ getFeed }) => {
	async function feed() {
		const url = new URL("/rss.xml", baseUrl);
		return getFeed({
			site: new URL(baseUrl),
			url,
			request: new Request(url),
			locals: {},
		} as Parameters<typeof getFeed>[0]);
	}

	it("exports complete rendered HTML alongside the excerpt and stable original URL", async () => {
		const response = await feed();
		const xml = await response.text();
		expect(response.headers.get("Content-Type")).toContain("application/rss+xml");
		expect(xml).toContain('xmlns:content="http://purl.org/rss/1.0/modules/content/"');
		expect(xml).toContain("<title>A &amp; B</title>");
		expect(xml).toContain("<description>Short &lt;summary&gt;</description>");
		expect(xml).toContain("<content:encoded><![CDATA[");
		expect(xml).toMatch(/<h2[^>]*>Full heading<\/h2>/);
		expect(xml).toContain("Full body, beyond the summary.");
		expect(xml).toContain("<pre");
		expect(xml).toContain('src="https://blog.example.com/_emdash/api/media/file/cover.jpg"');
		expect(xml).toContain(
			'<guid isPermaLink="true">https://blog.example.com/posts/full-post</guid>',
		);
	});

	it("uses public content even inside an editor or preview request", async () => {
		vi.mocked(getEmDashCollection).mockImplementation(async () => {
			expect(getRequestContext()?.editMode).toBe(false);
			expect(getRequestContext()?.preview).toBeUndefined();
			return { entries: [post()], cacheHint: {} } as Awaited<
				ReturnType<typeof getEmDashCollection>
			>;
		});
		await runWithContext({ editMode: true, preview: { collection: "posts", id: "draft" } }, feed);
		expect(vi.mocked(getEmDashCollection).mock.calls.at(-1)?.[1]).toMatchObject({
			status: "published",
			limit: 20,
		});
	});

	it("keeps excerpt-only items readable and handles an empty feed", async () => {
		const item = post();
		item.data.content = [];
		vi.mocked(getEmDashCollection).mockResolvedValue({ entries: [item], cacheHint: {} } as Awaited<
			ReturnType<typeof getEmDashCollection>
		>);
		const xml = await (await feed()).text();
		expect(xml).toContain("Short &lt;summary&gt;");
		expect(xml).not.toContain("<content:encoded>");
		vi.mocked(getEmDashCollection).mockResolvedValue({ entries: [], cacheHint: {} });
		expect(await (await feed()).text()).not.toContain("<item>");
	});
});

it("splits CDATA terminators and resolves document-relative links and responsive images", () => {
	expect(cdata("before ]]> after")).toBe("<![CDATA[before ]]]]><![CDATA[> after]]>");
	const html =
		'<a href="../next?a=1&amp;b=2">Next</a><img src="/cover.jpg" srcset="/cover.jpg 1x, /large.jpg 2x">';
	expect(absoluteFeedUrls(html, baseUrl + "/posts/full-post")).toContain(
		'href="https://blog.example.com/next?a=1&amp;b=2"',
	);
	expect(absoluteFeedUrls(html, baseUrl + "/posts/full-post")).toContain(
		'srcset="https://blog.example.com/cover.jpg 1x, https://blog.example.com/large.jpg 2x"',
	);
});
