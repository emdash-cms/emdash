import { afterEach, describe, expect, it } from "vitest";

import { HTML_BLOCK_FRAME_MESSAGE, buildHtmlBlockFrame } from "../../src/html-block";

function parse(source: { html: string; css?: string; js?: string }): Document {
	return new DOMParser().parseFromString(buildHtmlBlockFrame(source), "text/html");
}

function mountFrame(source: { html: string; css?: string; js?: string }): HTMLIFrameElement {
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.srcdoc = buildHtmlBlockFrame(source);
	document.body.append(frame);
	return frame;
}

function nextMessage(
	frame: HTMLIFrameElement,
	accept: (data: unknown) => boolean,
): Promise<unknown> {
	return new Promise((resolve) => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.contentWindow || !accept(event.data)) return;
			window.removeEventListener("message", onMessage);
			resolve(event.data);
		};
		window.addEventListener("message", onMessage);
	});
}

async function nextHeight(frame: HTMLIFrameElement): Promise<unknown> {
	const data = await nextMessage(
		frame,
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"type" in value &&
			value.type === HTML_BLOCK_FRAME_MESSAGE &&
			"height" in value,
	);
	return (data as { height: unknown }).height;
}

afterEach(() => {
	for (const frame of document.querySelectorAll("iframe")) frame.remove();
});

describe("buildHtmlBlockFrame", () => {
	it("keeps </script> in the JavaScript inside its element", () => {
		const doc = parse({
			html: "<p>Hello</p>",
			js: 'const markup = "</script><p id=leak></p>";',
		});

		expect(doc.getElementById("leak")).toBeNull();
		expect(doc.body.lastElementChild?.tagName).toBe("SCRIPT");
	});

	it("keeps a script-like comment in the JavaScript from swallowing the document", () => {
		const doc = parse({
			html: "<p>Hello</p>",
			js: 'const markup = "<!--<script>";',
		});

		expect(doc.body.lastElementChild?.tagName).toBe("SCRIPT");
		expect(doc.body.lastElementChild?.textContent).not.toContain("</body>");
	});

	it("keeps </style> in the CSS inside its element", () => {
		const doc = parse({
			html: "<p>Hello</p>",
			css: "p { color: red; } </style><p id=leak></p>",
		});

		expect(doc.getElementById("leak")).toBeNull();
	});

	it("keeps the frame script when the HTML ends in an unclosed comment", () => {
		const doc = parse({ html: "<p>Hello</p><!--" });

		expect(doc.head.querySelector("script")?.textContent).toContain(HTML_BLOCK_FRAME_MESSAGE);
	});
});

describe("HTML block frame", () => {
	it("reports its content height to the parent", async () => {
		const frame = mountFrame({ html: '<div style="height: 240px"></div>' });

		expect(await nextHeight(frame)).toBe(240);
	});

	it("reports its content height when the CSS pins the root to the frame", async () => {
		const frame = mountFrame({
			html: '<div style="height: 240px"></div>',
			css: "html, body { height: 100%; }",
		});

		expect(await nextHeight(frame)).toBe(240);
	});

	it("reports its height again when the parent asks", async () => {
		const frame = mountFrame({ html: '<div style="height: 240px"></div>' });
		await nextHeight(frame);

		const answer = nextHeight(frame);
		frame.contentWindow?.postMessage({ type: HTML_BLOCK_FRAME_MESSAGE }, "*");

		expect(await answer).toBe(240);
	});

	it("runs JavaScript that compares with a name starting with script", async () => {
		const frame = mountFrame({
			html: "<p>Hello</p>",
			js: 'const scripts = ["ran"];\nfor (let i = 0; i<scripts.length; i++) parent.postMessage(scripts[i], "*");',
		});

		expect(await nextMessage(frame, (data) => data === "ran")).toBe("ran");
	});

	it("runs a style and a script written in the HTML", async () => {
		const frame = mountFrame({
			html: '<style>p { margin: 0; height: 240px; }</style><p>Hello</p><script>parent.postMessage("ran", "*");</script>',
		});

		const ran = nextMessage(frame, (data) => data === "ran");
		const height = nextHeight(frame);

		expect(await ran).toBe("ran");
		expect(await height).toBe(240);
	});

	it("doesn't show its JavaScript the page's path, query or fragment", async () => {
		const page = location.href;
		history.replaceState(null, "", "/posts/draft?_preview=secret#token=secret");
		try {
			const frame = mountFrame({
				html: '<a href="docs">Docs</a>',
				js: 'parent.postMessage({ base: document.baseURI, link: document.querySelector("a").href }, "*");',
			});

			expect(
				await nextMessage(
					frame,
					(data) => typeof data === "object" && data !== null && "base" in data,
				),
			).toEqual({
				base: `${location.origin}/`,
				link: `${location.origin}/docs`,
			});
		} finally {
			history.replaceState(null, "", page);
		}
	});

	it("runs JavaScript that opens with a legacy HTML comment", async () => {
		const frame = mountFrame({
			html: "<p>Hello</p>",
			js: '<!--\nparent.postMessage("ran", "*");\n//-->',
		});

		expect(await nextMessage(frame, (data) => data === "ran")).toBe("ran");
	});
});
