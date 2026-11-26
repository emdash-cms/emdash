import { afterEach, describe, expect, it, vi } from "vitest";

import { HTML_BLOCK_FRAME_MESSAGE, buildHtmlBlockFrame } from "../../src/html-block";

type Source = { html: string; css?: string; js?: string; title?: string };

function parseShell(source: Source): Document {
	return new DOMParser().parseFromString(buildHtmlBlockFrame(source), "text/html");
}

/** The author's document, which the frame's shell holds in its own frame. */
function parse(source: Source): Document {
	const srcdoc = parseShell(source).querySelector("iframe")?.srcdoc ?? "";
	return new DOMParser().parseFromString(srcdoc, "text/html");
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

	it("keeps the author's code inside the frame that holds it", () => {
		const source = {
			html: '<p title="&quot;a&amp;b">"></iframe><p id=leak></p>',
			css: 'p::after { content: "</iframe>"; }',
			js: "const markup = '\"></iframe><p id=leak></p>';",
			title: 'A "quoted" <title>',
		};
		const shell = parseShell(source);
		const inner = shell.querySelector("iframe");

		expect(shell.getElementById("leak")).toBeNull();
		expect(Array.from(shell.body.children, (element) => element.tagName)).toEqual(["IFRAME"]);
		expect(inner?.sandbox.contains("allow-scripts")).toBe(true);
		expect(inner?.sandbox.contains("allow-same-origin")).toBe(false);
		expect(inner?.title).toBe('A "quoted" <title>');
		expect(parse(source).querySelector("p")?.title).toBe('"a&b');
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

	it("doesn't show its JavaScript the page's URL after the script removes the frame's base", async () => {
		const page = location.href;
		history.replaceState(null, "", "/posts/draft?_preview=secret#token=secret");
		try {
			const frame = mountFrame({
				html: '<a href="docs">Docs</a>',
				js:
					'document.querySelector("base").remove();\n' +
					'parent.postMessage({ base: document.baseURI, link: document.querySelector("a").href, referrer: document.referrer }, "*");',
			});

			const data = await nextMessage(
				frame,
				(value) => typeof value === "object" && value !== null && "base" in value,
			);
			expect(data).toEqual({
				base: `${location.origin}/`,
				link: `${location.origin}/docs`,
				referrer: "",
			});
			expect(JSON.stringify(data)).not.toContain("secret");
		} finally {
			history.replaceState(null, "", page);
		}
	});

	it("doesn't show its JavaScript the page's URL after the script removes its head", async () => {
		const page = location.href;
		history.replaceState(null, "", "/posts/draft?_preview=secret#token=secret");
		try {
			const frame = mountFrame({
				html: "<p>Hello</p>",
				js: 'document.head.remove();\nparent.postMessage({ base: document.baseURI }, "*");',
			});

			expect(
				await nextMessage(
					frame,
					(data) => typeof data === "object" && data !== null && "base" in data,
				),
			).toEqual({ base: `${location.origin}/` });
		} finally {
			history.replaceState(null, "", page);
		}
	});

	it("passes messages from the page to the block's JavaScript", async () => {
		const frame = mountFrame({
			html: "<p>Hello</p>",
			js: 'addEventListener("message", (event) => { if (event.data === "ping") parent.postMessage("pong", "*"); });\nparent.postMessage("ready", "*");',
		});
		await nextMessage(frame, (data) => data === "ready");

		const answer = nextMessage(frame, (data) => data === "pong");
		frame.contentWindow?.postMessage("ping", "*");

		expect(await answer).toBe("pong");
	});

	it("doesn't load the block when a CSP rejects the frame's base", async () => {
		const page = location.href;
		history.replaceState(null, "", "/posts/draft?_preview=secret#token=secret");
		try {
			const csp = `<meta http-equiv="Content-Security-Policy" content="base-uri 'none'">`;
			const frame = document.createElement("iframe");
			// Same-origin access lets the test look inside the shell.
			frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
			frame.srcdoc = buildHtmlBlockFrame({
				html: "<p>Hello</p>",
				js: 'parent.postMessage({ base: document.baseURI }, "*");',
			}).replace("<head>", `<head>${csp}`);
			document.body.append(frame);
			await vi.waitFor(() => {
				expect(frame.contentDocument?.URL).toBe("about:srcdoc");
				expect(frame.contentDocument?.readyState).not.toBe("loading");
			});

			expect(frame.contentDocument!.querySelector("iframe")).toBeNull();
		} finally {
			history.replaceState(null, "", page);
		}
	});

	it("fills the frame without margins or a border when a CSP blocks its inline styles", async () => {
		const csp =
			"<meta http-equiv=\"Content-Security-Policy\" content=\"style-src 'none'; script-src 'none'\">";
		const frame = document.createElement("iframe");
		// Same-origin access lets the test measure the shell; scripts stay off.
		frame.setAttribute("sandbox", "allow-same-origin");
		frame.style.width = "600px";
		frame.srcdoc = buildHtmlBlockFrame({ html: "<p>Hello</p>" }).replace("<head>", `<head>${csp}`);
		const loaded = new Promise((resolve) => frame.addEventListener("load", resolve));
		document.body.append(frame);
		await loaded;

		const shell = frame.contentDocument!;
		const root = shell.documentElement;
		const inner = shell.querySelector("iframe")!;
		expect(shell.defaultView!.getComputedStyle(inner).display).not.toBe("block");
		expect(inner.getBoundingClientRect().toJSON()).toMatchObject({
			x: 0,
			y: 0,
			width: root.clientWidth,
			height: root.clientHeight,
		});
		expect(shell.defaultView!.getComputedStyle(inner).borderTopWidth).toBe("0px");
		expect(root.scrollHeight).toBe(root.clientHeight);
		expect(root.scrollWidth).toBe(root.clientWidth);
	});

	it("runs JavaScript that opens with a legacy HTML comment", async () => {
		const frame = mountFrame({
			html: "<p>Hello</p>",
			js: '<!--\nparent.postMessage("ran", "*");\n//-->',
		});

		expect(await nextMessage(frame, (data) => data === "ran")).toBe("ran");
	});
});
