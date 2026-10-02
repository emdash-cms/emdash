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
});

describe("Iframe block preview", () => {
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
