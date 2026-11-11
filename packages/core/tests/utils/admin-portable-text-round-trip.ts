import {
	portableTextSchema,
	portableTextToProsemirror,
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

type Schema = ReturnType<typeof portableTextSchema>;

let schema: Schema | undefined;

/**
 * Portable Text → editor document → shared document → editor document →
 * Portable Text, the way a room reads and writes rich text.
 */
export function roundTripThroughSharedDocument(
	blocks: PortableTextBlock[],
	pluginTypes?: ReadonlySet<string>,
): PortableTextBlock[] {
	schema ??= portableTextSchema();
	const fragment = new Y.Doc().getXmlFragment("prosemirror");
	prosemirrorJSONToYXmlFragment(schema, portableTextToProsemirror(blocks, pluginTypes), fragment);
	return prosemirrorToPortableText(yXmlFragmentToProsemirrorJSON(fragment));
}

/** Portable Text → editor document → Portable Text, with no schema in between. */
export function roundTripThroughConverter(
	blocks: PortableTextBlock[],
	pluginTypes?: ReadonlySet<string>,
): PortableTextBlock[] {
	return prosemirrorToPortableText(portableTextToProsemirror(blocks, pluginTypes));
}

const span = (key: string, text: string, marks?: string[]) => ({
	_type: "span",
	_key: key,
	text,
	...(marks ? { marks } : {}),
});

const paragraph = (key: string, text: string) => ({
	_type: "block",
	_key: key,
	style: "normal",
	children: [span(`${key}-s`, text)],
});

export interface RoundTripFixture {
	name: string;
	blocks: PortableTextBlock[];
	pluginTypes?: ReadonlySet<string>;
}

/** Canonical Portable Text for every node, mark and plugin block the editor ships. */
export const editorFixtures: RoundTripFixture[] = [
	{
		name: "paragraphs and headings with alignment",
		blocks: [
			paragraph("p1", "Plain paragraph"),
			{ ...paragraph("p2", "Centered"), textAlign: "center" },
			{ ...paragraph("p3", "Right"), textAlign: "right" },
			{ ...paragraph("p4", "Justified"), textAlign: "justify" },
			...[1, 2, 3, 4, 5, 6].map((level) => ({
				...paragraph(`h${level}`, `Heading ${level}`),
				style: `h${level}`,
			})),
			{ ...paragraph("h7", "Centered heading"), style: "h2", textAlign: "center" },
		],
	},
	{
		name: "decorators",
		blocks: [
			{
				_type: "block",
				_key: "marks",
				style: "normal",
				children: [
					span("s1", "bold", ["strong"]),
					span("s2", " italic", ["em"]),
					span("s3", " underline", ["underline"]),
					span("s4", " strike", ["strike-through"]),
					span("s5", " sub", ["subscript"]),
					span("s6", " super", ["superscript"]),
					span("s7", " code", ["code"]),
					span("s8", " plain"),
				],
			},
		],
	},
	{
		name: "stacked decorators",
		blocks: [
			{
				_type: "block",
				_key: "stacked",
				style: "normal",
				children: [
					span("s1", "italic", ["em"]),
					span("s2", " bold italic", ["strong", "em"]),
					span("s3", " all", ["strong", "em", "strike-through", "underline"]),
					span("s4", " underline", ["underline"]),
				],
			},
		],
	},
	{
		name: "links, including linked code and a link opening in a new tab",
		blocks: [
			{
				_type: "block",
				_key: "links",
				style: "normal",
				markDefs: [
					{ _type: "link", _key: "l1", href: "https://example.com" },
					{ _type: "link", _key: "l2", href: "/about", blank: true },
				],
				children: [
					span("s1", "Read "),
					span("s2", "this", ["l1"]),
					span("s3", " and "),
					span("s4", "that", ["l2", "code"]),
				],
			},
		],
	},
	{
		name: "line breaks anywhere in a span, with and without marks",
		blocks: [
			{
				_type: "block",
				_key: "lb1",
				style: "normal",
				children: [
					span("lb1a", "\nLeading"),
					span("lb1b", " middle\nof", ["strong"]),
					span("lb1c", " trailing\n", ["em"]),
					span("lb1d", "next"),
				],
			},
			{
				_type: "block",
				_key: "lb2",
				style: "normal",
				children: [
					span("lb2a", "\nBold leading", ["strong"]),
					span("lb2b", "\n\nRepeated\n\n"),
					span("lb2c", "\n"),
					span("lb2d", "\nItalic after a break", ["em", "underline"]),
				],
			},
			{
				_type: "block",
				_key: "lb3",
				style: "normal",
				markDefs: [{ _type: "link", _key: "lbl", href: "https://example.com" }],
				children: [span("lb3a", "\nLinked\nlines\n", ["lbl", "strong"]), span("lb3b", "\n")],
			},
			{ _type: "block", _key: "lb4", style: "normal", children: [span("lb4a", "\n")] },
			{ ...paragraph("lb5", "Heading\non two lines"), style: "h2" },
			{ ...paragraph("lb6", "\nQuoted\nlines\n"), style: "blockquote" },
			{ ...paragraph("lb7", "List item\non two lines"), listItem: "bullet", level: 1 },
		],
	},
	{
		name: "line breaks in table cells",
		blocks: [
			{
				_type: "table",
				_key: "lt",
				rows: [
					{
						_type: "tableRow",
						_key: "ltr",
						cells: [
							{
								_type: "tableCell",
								_key: "ltc1",
								isHeader: false,
								markDefs: [{ _type: "link", _key: "ltl", href: "https://example.com" }],
								content: [
									span("ltc1a", "First", ["ltl"]),
									span("ltc1b", "\n"),
									span("ltc1c", "Second", ["em"]),
								],
							},
							{
								_type: "tableCell",
								_key: "ltc2",
								isHeader: false,
								content: [span("ltc2a", "\n"), span("ltc2b", "Leading")],
							},
							{
								_type: "tableCell",
								_key: "ltc3",
								isHeader: false,
								content: [span("ltc3a", "Trailing"), span("ltc3b", "\n")],
							},
							{
								_type: "tableCell",
								_key: "ltc4",
								isHeader: false,
								content: [
									span("ltc4a", "A"),
									span("ltc4b", "\n"),
									span("ltc4c", "\n"),
									span("ltc4d", "B"),
								],
							},
							{
								_type: "tableCell",
								_key: "ltc5",
								isHeader: false,
								content: [span("ltc5a", "\nOne span\nof lines\n", ["strong"])],
							},
						],
					},
				],
			},
		],
	},
	{
		name: "quotes of one and several paragraphs",
		blocks: [
			{ ...paragraph("q1", "A short quote"), style: "blockquote" },
			paragraph("between", "Between quotes"),
			{ ...paragraph("q2", "First paragraph"), style: "blockquote" },
			{ ...paragraph("q3", "Second paragraph"), style: "blockquote" },
		],
	},
	{
		name: "nested bullet and numbered lists",
		blocks: [
			{ ...paragraph("b1", "Bullet one"), listItem: "bullet", level: 1 },
			{
				...paragraph("n1", "Nested number one"),
				listItem: "number",
				level: 2,
				listId: "nested",
				listStart: 1,
			},
			{
				...paragraph("n2", "Nested number two"),
				listItem: "number",
				level: 2,
				listId: "nested",
				listStart: 1,
			},
			{ ...paragraph("b2", "Deep bullet"), listItem: "bullet", level: 3 },
			{ ...paragraph("b3", "Bullet two"), listItem: "bullet", level: 1 },
			paragraph("after", "After the lists"),
			{
				...paragraph("o1", "Numbered from five"),
				listItem: "number",
				level: 1,
				listId: "from-five",
				listStart: 5,
			},
			{
				...paragraph("o2", "Six"),
				listItem: "number",
				level: 1,
				listId: "from-five",
				listStart: 5,
			},
		],
	},
	{
		name: "code blocks",
		blocks: [
			{ _type: "code", _key: "c1", code: "const a = 1;\nconsole.log(a);", language: "ts" },
			{ _type: "code", _key: "c2", code: "plain text" },
		],
	},
	{
		name: "HTML blocks",
		blocks: [
			{ _type: "htmlBlock", _key: "h1", html: "<p>Inline</p>" },
			{
				_type: "htmlBlock",
				_key: "h2",
				html: "<div id='app'></div>",
				css: "#app { color: red; }",
				js: "document.getElementById('app').textContent = 'Hi';",
				isolated: true,
			},
		],
	},
	{
		name: "iframe block",
		blocks: [
			{
				_type: "iframe",
				_key: "i1",
				src: "https://www.youtube.com/embed/dQw4w9WgXcQ",
				title: "A video",
				width: 560,
				height: 315,
				allow: "autoplay; fullscreen",
				allowFullscreen: true,
			},
		],
	},
	{
		name: "video blocks",
		blocks: [
			{
				_type: "video",
				_key: "v1",
				asset: { _ref: "media-1", url: "/_emdash/api/media/file/clip.mp4" },
				caption: "A clip",
				width: 1920,
				height: 1080,
			},
			{
				_type: "video",
				_key: "v2",
				asset: { _ref: "", url: "https://cdn.example.com/clip.mp4", provider: "external" },
			},
			{ _type: "video", _key: "v3" },
		],
	},
	{
		name: "images",
		blocks: [
			{
				_type: "image",
				_key: "img1",
				asset: { _ref: "media-1", url: "/_emdash/api/media/file/photo.jpg" },
				alt: "A photo",
				caption: "Its caption",
				title: "Its title",
				width: 1200,
				height: 800,
				blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
				dominantColor: "#336699",
				displayWidth: 600,
				displayHeight: 400,
				alignment: "wide",
				link: { href: "https://example.com", blank: true },
			},
			{
				_type: "image",
				_key: "img2",
				asset: {
					_ref: "cf-1",
					url: "https://imagedelivery.net/x/y",
					provider: "cloudflare-images",
				},
				alignment: "left",
				link: { href: "/gallery" },
			},
		],
	},
	{
		name: "divider",
		blocks: [
			paragraph("before", "Before"),
			{ _type: "break", _key: "hr", style: "lineBreak" },
			paragraph("after", "After"),
		],
	},
	{
		name: "gallery",
		blocks: [
			{
				_type: "gallery",
				_key: "g1",
				columns: 2,
				images: [
					{
						_type: "image",
						_key: "gi1",
						asset: { _type: "reference", _ref: "media-1", url: "/_emdash/api/media/file/a.jpg" },
						alt: "First",
						caption: "One",
						width: 800,
						height: 600,
						focalX: 0.25,
						focalY: 0.75,
						blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
						dominantColor: "#aabbcc",
					},
					{
						_type: "image",
						_key: "gi2",
						asset: { _type: "reference", _ref: "cf-2", provider: "cloudflare-images" },
					},
				],
			},
		],
	},
	{
		name: "table with a header row, spans, widths, alignment and marks",
		blocks: [
			{
				_type: "table",
				_key: "t1",
				hasHeaderRow: true,
				rows: [
					{
						_type: "tableRow",
						_key: "r1",
						cells: [
							{
								_type: "tableCell",
								_key: "c1",
								isHeader: true,
								colspan: 2,
								colwidth: [160, 224],
								textAlign: "center",
								content: [span("c1s", "Report", ["strong"])],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "r2",
						cells: [
							{
								_type: "tableCell",
								_key: "c2",
								isHeader: false,
								colwidth: [160],
								markDefs: [{ _type: "link", _key: "tl", href: "https://example.com" }],
								content: [span("c2s", "Linked", ["tl"]), span("c2t", " text", ["em"])],
							},
							{
								_type: "tableCell",
								_key: "c3",
								isHeader: false,
								rowspan: 2,
								colwidth: [224],
								content: [span("c3s", "Tall")],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "r3",
						cells: [
							{
								_type: "tableCell",
								_key: "c4",
								isHeader: false,
								colwidth: [160],
								content: [span("c4s", "Last")],
							},
						],
					},
				],
			},
		],
	},
	{
		name: "plugin blocks",
		blocks: [
			{ _type: "youtube", _key: "yt", id: "dQw4w9WgXcQ", title: "A video", posterQuality: "high" },
			{ _type: "vimeo", _key: "vm", id: "76979871", params: "autoplay=1" },
			{ _type: "tweet", _key: "tw", id: "https://x.com/user/status/1", theme: "dark" },
			{ _type: "bluesky", _key: "bs", id: "at://did:plc:abc/app.bsky.feed.post/xyz" },
			{ _type: "mastodon", _key: "md", id: "https://mastodon.social/@user/1" },
			{ _type: "linkPreview", _key: "lp", id: "https://example.com", hideMedia: true },
			{ _type: "gist", _key: "gs", id: "https://gist.github.com/user/abc", file: "a.ts" },
			{ _type: "emdash-form", _key: "fm", formId: "contact" },
			{ _type: "embed", _key: "em", url: "https://example.com/embed", _meta: { source: "import" } },
			{ _type: "callout", _key: "co", tone: "warning", body: { text: "Nested data" } },
		],
	},
	{
		name: "iframe and video blocks a plugin owns",
		pluginTypes: new Set(["iframe", "video"]),
		blocks: [
			{ _type: "iframe", _key: "pi", src: "https://example.com/widget", title: "Widget" },
			{ _type: "video", _key: "pv", asset: { _ref: "media-1" } },
		],
	},
	{
		name: "iframe, video and gallery blocks with fields the editor doesn't know",
		blocks: [
			{ _type: "iframe", _key: "xi", src: "https://example.com", sandbox: "allow-scripts" },
			{ _type: "video", _key: "xv", id: "abc", autoplay: true },
			{ _type: "gallery", _key: "xg", images: "not an array" },
		],
	},
];
