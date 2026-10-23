/**
 * Iframe block editing through the full editor: the Code tab's parsing and
 * canonical code, the Preview tab, and conversion.
 */

import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	PortableTextEditor,
	_portableTextToProsemirror as portableTextToProsemirror,
	_prosemirrorToPortableText as prosemirrorToPortableText,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

import "../../src/styles.css";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

type Block = { _type: string; _key: string; [key: string]: unknown };

const YOUTUBE_EMBED = "https://www.youtube.com/embed/dQw4w9WgXcQ";

const INTRO: Block = {
	_type: "block",
	_key: "intro",
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: "intro-span", text: "Intro", marks: [] }],
};

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editor: Editor | null = null;
	const changes: Block[][] = [];
	const screen = await render(
		<PortableTextEditor
			onEditorReady={(instance) => {
				editor = instance;
			}}
			onChange={(value) => changes.push(value as Block[])}
			{...props}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	const pm = document.querySelector<HTMLElement>(".ProseMirror")!;
	const latest = (): Block[] => changes.at(-1) ?? ((props.value ?? []) as Block[]);
	return { screen, editor: editor!, pm, latest };
}

function frames(value: Block[]): Block[] {
	return value.filter((block) => block._type === "iframe");
}

function codeEditor(): HTMLElement | null {
	return document.querySelector<HTMLElement>(".iframe-block .cm-content");
}

async function insertFromSlashMenu(pm: HTMLElement) {
	pm.focus();
	await userEvent.keyboard("/iframe");
	await vi.waitFor(() => expect(document.querySelector("[data-slash-command-menu]")).toBeTruthy());
	await userEvent.keyboard("{Enter}");
	await vi.waitFor(() => expect(document.activeElement).toBe(codeEditor()));
}

describe("Iframe block editor", () => {
	it("inserts a block from /iframe with its Code tab focused", async () => {
		const { screen, pm, latest } = await renderEditor();

		await insertFromSlashMenu(pm);

		await expect
			.element(screen.getByRole("tab", { name: "Code" }))
			.toHaveAttribute("aria-selected", "true");
		await vi.waitFor(() =>
			expect(frames(latest())).toEqual([{ _type: "iframe", _key: expect.any(String), src: "" }]),
		);
	});

	it("highlights a new block's selected tab and moves between tabs with the arrow keys", async () => {
		const { screen, pm } = await renderEditor();
		await insertFromSlashMenu(pm);

		await vi.waitFor(() => {
			const indicator = document.querySelector<HTMLElement>(
				".iframe-block [role='tablist'] > [role='presentation']",
			);
			expect(indicator?.checkVisibility()).toBe(true);
		});
		screen.getByRole("tab", { name: "Code" }).element().focus();
		await userEvent.keyboard("{ArrowRight}");
		await expect
			.element(screen.getByRole("tab", { name: "Preview" }))
			.toHaveAttribute("aria-selected", "true");
	});

	it("turns a pasted YouTube link into the player and shows it in Preview", async () => {
		const { screen, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);

		await userEvent.keyboard("https://youtu.be/dQw4w9WgXcQ");

		await vi.waitFor(() =>
			expect(frames(latest())[0]).toMatchObject({
				src: YOUTUBE_EMBED,
				width: 560,
				height: 315,
				allowFullscreen: true,
			}),
		);
		await screen.getByRole("tab", { name: "Preview" }).click();
		await vi.waitFor(() =>
			expect(document.querySelector<HTMLIFrameElement>(".iframe-block iframe")?.src).toBe(
				YOUTUBE_EMBED,
			),
		);
	});

	it("saves a link that waited while the editor was read-only", async () => {
		const { screen, editor, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("https://example.com/map");
		editor.setEditable(false);
		await new Promise((resolve) => setTimeout(resolve, 400));
		editor.setEditable(true);

		await screen.getByRole("tab", { name: "Preview" }).click();

		await vi.waitFor(() => expect(frames(latest())[0]?.src).toBe("https://example.com/map"));
	});

	it("keeps showing a link that waits for the editor when the code editor loses focus", async () => {
		const { editor, pm, latest } = await renderEditor({ value: [INTRO] });
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("https://example.com/map");
		editor.setEditable(false);
		await new Promise((resolve) => setTimeout(resolve, 400));

		await userEvent.click(pm.querySelector("p")!);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(codeEditor()?.textContent).toContain("https://example.com/map");
		expect(frames(latest())[0]?.src).toBe("");
	});

	it("shows why input is rejected and keeps the saved embed", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const { screen, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		await vi.waitFor(() => expect(codeEditor()).not.toBeNull());
		await userEvent.click(codeEditor()!);

		await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}http://example.com/insecure");

		await expect.element(screen.getByText("Only https links can be embedded.")).toBeVisible();
		expect(codeEditor()).toHaveAccessibleDescription(/Only https links can be embedded\./);
		expect(frames(latest())).toEqual([saved]);
	});

	it("replaces a link with the saved embed code when the code editor loses focus", async () => {
		const { pm } = await renderEditor({ value: [INTRO] });
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("https://youtu.be/dQw4w9WgXcQ");

		await userEvent.click(pm.querySelector("p")!);

		await vi.waitFor(() =>
			expect(codeEditor()?.textContent).toContain(`<iframe src="${YOUTUBE_EMBED}"`),
		);
	});

	it("saves another URL after parsing the saved URL again", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const { screen, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		const input = screen.getByRole("textbox", { name: "Embed code" });
		await input.fill("https://example.com/map");
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(frames(latest())).toEqual([saved]);

		await input.fill("https://example.com/next");
		await screen.getByRole("tab", { name: "Preview" }).click();

		await vi.waitFor(() => expect(frames(latest())[0]?.src).toBe("https://example.com/next"));
	});

	it("converts a complete embed after parsing the saved URL again", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const html =
			'<div><iframe src="https://example.com/chart" data-theme="auto"></iframe><script src="https://example.com/resize.js"></script></div>';
		const { screen, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		const input = screen.getByRole("textbox", { name: "Embed code" });
		await input.fill("https://example.com/map");
		await new Promise((resolve) => setTimeout(resolve, 350));
		await input.fill(html);
		await screen.getByRole("button", { name: "Use as HTML block" }).click();

		await vi.waitFor(() =>
			expect(latest()).toEqual([{ _type: "htmlBlock", _key: "saved", html, isolated: true }]),
		);
	});

	it("flushes a second edit before a toolbar undo after an automatic write", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/start" };
		const { screen, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		const input = screen.getByRole("textbox", { name: "Embed code" });
		await input.fill("https://example.com/first");
		await vi.waitFor(() => expect(frames(latest())[0]?.src).toBe("https://example.com/first"));
		await new Promise((resolve) => setTimeout(resolve, 650));

		await input.fill("https://example.com/second");
		await screen.getByRole("button", { name: "Undo", exact: true }).click();

		await vi.waitFor(() => expect(frames(latest())[0]?.src).toBe("https://example.com/first"));
	});

	it("keeps a complete embed through blur and tab changes until the author converts it", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const html =
			'<div class="chart"><iframe src="https://embed.example.com/chart" data-theme="auto"></iframe><script src="https://embed.example.com/resize.js"></script></div>';
		const { screen, editor, pm, latest } = await renderEditor({ value: [INTRO, saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		await screen.getByRole("textbox", { name: "Embed code" }).fill(html);

		await expect.element(screen.getByRole("button", { name: "Use as HTML block" })).toBeVisible();
		expect(frames(latest())).toEqual([saved]);
		await userEvent.click(pm.querySelector("p")!);
		expect(codeEditor()?.textContent).toBe(html);
		await screen.getByRole("tab", { name: "Preview" }).click();
		await screen.getByRole("tab", { name: "Code" }).click();
		expect(codeEditor()?.textContent).toBe(html);

		await screen.getByRole("button", { name: "Use as HTML block" }).click();

		await vi.waitFor(() =>
			expect(latest().find((block) => block._key === "saved")).toEqual({
				_type: "htmlBlock",
				_key: "saved",
				html,
				isolated: true,
			}),
		);
		expect(frames(latest())).toEqual([]);
		expect(latest()[0]).toMatchObject({
			_type: "block",
			_key: "intro",
			children: [{ _type: "span", _key: "intro-span", text: "Intro" }],
		});
		editor.commands.undo();
		await vi.waitFor(() => expect(frames(latest())).toEqual([saved]));
	});

	it("converts the latest script-only snippet after a read-only transition", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const first = '<script src="https://embed.example.com/first.js"></script>';
		const latestScript = '<script src="https://embed.example.com/latest.js"></script>';
		const { screen, editor, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		await screen.getByRole("textbox", { name: "Embed code" }).fill(first);
		await expect.element(screen.getByRole("button", { name: "Use as HTML block" })).toBeVisible();
		await screen.getByRole("textbox", { name: "Embed code" }).fill(latestScript);
		await expect.element(screen.getByRole("button", { name: "Use as HTML block" })).toBeVisible();
		editor.setEditable(false);
		await expect.element(screen.getByRole("button", { name: "Use as HTML block" })).toBeDisabled();
		expect(frames(latest())).toEqual([saved]);
		editor.setEditable(true);
		await screen.getByRole("button", { name: "Use as HTML block" }).click();

		await vi.waitFor(() =>
			expect(latest()).toEqual([
				{ _type: "htmlBlock", _key: "saved", html: latestScript, isolated: true },
			]),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(latest()).toEqual([
			{ _type: "htmlBlock", _key: "saved", html: latestScript, isolated: true },
		]);
	});

	it("drops a pending snippet when external content replaces the iframe", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const { screen, editor, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		await screen.getByRole("textbox", { name: "Embed code" }).fill("https://example.com/pending");
		editor.commands.setContent({
			type: "doc",
			content: [{ type: "iframeBlock", attrs: { src: "https://example.com/replaced" } }],
		});

		await vi.waitFor(() => expect(frames(latest())[0]?.src).toBe("https://example.com/replaced"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(frames(latest())[0]?.src).toBe("https://example.com/replaced");
		expect(codeEditor()?.textContent).not.toContain("https://example.com/pending");
	});
});

describe("Iframe block preview", () => {
	it("lets provider height updates size the preview and its container", async () => {
		const { screen } = await renderEditor({
			value: [{ _type: "iframe", _key: "chart", src: "https://example.com/chart", height: 450 }],
		});
		await screen.getByRole("button", { name: "Load preview" }).click();
		await vi.waitFor(() => expect(document.querySelector(".iframe-block iframe")).not.toBeNull());
		const frame = document.querySelector<HTMLIFrameElement>(".iframe-block iframe");
		if (!frame?.parentElement) throw new Error("The preview did not mount");
		const container = frame.parentElement;
		expect(frame.getBoundingClientRect().height).toBe(450);
		for (const height of [640, 240]) {
			frame.setAttribute("height", String(height));
			expect(frame.getBoundingClientRect().height).toBe(height);
			expect(container.getBoundingClientRect().height).toBe(height);
		}
		frame.style.height = "720px";
		expect(frame.getBoundingClientRect().height).toBe(720);
		expect(container.getBoundingClientRect().height).toBe(720);
	});

	it("previews only https sources, without same-origin access to the admin", async () => {
		const blocks: Block[] = [
			{ _type: "iframe", _key: "relative", src: "/" },
			{ _type: "iframe", _key: "own", src: `https://${window.location.host}/page` },
		];
		const { screen } = await renderEditor({ value: blocks });

		await expect
			.element(screen.getByText(`This block embeds a page from ${window.location.host}.`))
			.toBeVisible();
		expect(document.querySelector(".iframe-block iframe")).toBeNull();
		await screen.getByRole("button", { name: "Load preview" }).click();

		await vi.waitFor(() =>
			expect(document.querySelectorAll(".iframe-block iframe")).toHaveLength(1),
		);
		const cards = document.querySelectorAll(".iframe-block");
		expect(cards[0]?.textContent).toContain("Nothing to preview yet.");
		const sandbox = cards[1]?.querySelector("iframe")?.getAttribute("sandbox")?.split(" ");
		expect(sandbox).toContain("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");
	});

	it("clears the embed when the code is deleted", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const { screen, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		await userEvent.click(codeEditor()!);

		await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}{Backspace}");

		await vi.waitFor(() =>
			expect(frames(latest())).toEqual([{ _type: "iframe", _key: "saved", src: "" }]),
		);
	});
});

describe("Iframe block clipboard", () => {
	it("keeps iframes copied on this page and empties those from other pages", async () => {
		const { editor } = await renderEditor({
			value: [{ _type: "iframe", _key: "saved", src: "https://example.com/map", title: "Map" }],
		});
		const iframeAttrs = () =>
			editor.getJSON().content?.find((node) => node.type === "iframeBlock")?.attrs;

		editor.commands.setContent(editor.getHTML());
		expect(iframeAttrs()).toMatchObject({ src: "https://example.com/map", title: "Map" });

		editor.commands.setContent(
			'<div data-iframe-block data-iframe-src="https://example.com/login" data-iframe-title="Map"></div>',
		);
		expect(iframeAttrs()).toMatchObject({ src: "", title: "" });
	});
});

describe("Iframe block with a plugin's iframe block", () => {
	it("keeps the plugin's block and slash command", async () => {
		const saved: Block = { _type: "iframe", _key: "plugin", src: "https://example.com/" };
		const { pm } = await renderEditor({
			value: [INTRO, saved],
			pluginBlocks: [{ type: "iframe", pluginId: "maps", label: "Map embed" }],
		});

		await vi.waitFor(() => expect(document.querySelector(".plugin-block")).toBeTruthy());
		expect(document.querySelector(".iframe-block")).toBeNull();
		await userEvent.click(pm.querySelector("p")!);
		await userEvent.keyboard("{End}{Enter}/iframe");
		const menu = await vi.waitFor(() => {
			const element = document.querySelector("[data-slash-command-menu]");
			expect(element).toBeTruthy();
			return element!;
		});
		expect(menu.textContent).toContain("Map embed");
		expect(menu.textContent).not.toContain("Embed a page from another site");
	});
});

describe("Iframe block conversion", () => {
	it("round-trips every field and leaves a plugin's iframe block alone", () => {
		const embed: Block = {
			_type: "iframe",
			_key: "frame1",
			src: YOUTUBE_EMBED,
			title: "Launch video",
			width: 560,
			height: 315,
			allow: "autoplay",
			allowFullscreen: true,
		};
		const plugin: Block = {
			_type: "iframe",
			_key: "plugin1",
			src: "https://example.com/",
			theme: "dark",
		};
		const pluginSize: Block = {
			_type: "iframe",
			_key: "plugin2",
			src: "https://example.com/",
			width: "100%",
		};

		const pm = portableTextToProsemirror([embed, plugin, pluginSize]);

		expect(pm.content?.map((node) => (node as { type: string }).type)).toEqual([
			"iframeBlock",
			"pluginBlock",
			"pluginBlock",
		]);
		expect(prosemirrorToPortableText(pm)).toStrictEqual([embed, plugin, pluginSize]);
	});
});
