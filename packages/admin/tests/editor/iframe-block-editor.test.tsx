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

	it("shows why input is rejected and keeps the saved embed", async () => {
		const saved: Block = { _type: "iframe", _key: "saved", src: "https://example.com/map" };
		const { screen, latest } = await renderEditor({ value: [saved] });
		await screen.getByRole("tab", { name: "Code" }).click();
		await userEvent.click(codeEditor()!);

		await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}http://example.com/insecure");

		await expect.element(screen.getByText("Only https links can be embedded.")).toBeVisible();
		expect(frames(latest())).toEqual([saved]);
	});

	it("replaces a link with the saved embed code when the code editor loses focus", async () => {
		const { pm } = await renderEditor({
			value: [
				{
					_type: "block",
					_key: "intro",
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: "intro-span", text: "Intro", marks: [] }],
				},
			],
		});
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
		await renderEditor({ value: blocks });

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

		const pm = portableTextToProsemirror([embed, plugin]);

		expect(pm.content?.map((node) => (node as { type: string }).type)).toEqual([
			"iframeBlock",
			"pluginBlock",
		]);
		expect(prosemirrorToPortableText(pm)).toStrictEqual([embed, plugin]);
	});
});
