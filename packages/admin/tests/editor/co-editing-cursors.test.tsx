/**
 * Other people's carets, names and selections in a bound rich-text editor, through the session,
 * replica and loopback room the page uses.
 */

import { Editor as HeadlessEditor, Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import {
	absolutePositionToRelativePosition,
	prosemirrorJSONToYXmlFragment,
	ySyncPlugin,
	ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { editorSchema, fragmentName } from "../../src/co-editing/layout";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { FieldPresence } from "../../src/components/presence/FieldPresence";
import { PresenceAvatars } from "../../src/components/presence/PresenceAvatars";
import {
	portableTextExtensions,
	portableTextToProsemirror,
	type PortableTextBlock,
} from "../../src/internal/portable-text";
import { CURSOR_LABEL_MS } from "../../src/lib/co-editing/replica/cursors";
import type { RoomEditing } from "../../src/lib/co-editing/types";
import { PortableTextFilledDefaults } from "../../src/portable-text/schema";
import { PortableTextYSync } from "../../src/portable-text/y-sync";
import { LoopbackRoom, settle } from "../co-editing/loopback-room";
import {
	resetTransportHealth,
	startSession,
	type TestSession,
} from "../co-editing/session-harness";
import { adminRoot } from "../utils/form-layout";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

const LONG =
	"Co-editing keeps everyone on the same page while each person works on a different part of it.";
const ARABIC = "يراجع الفريق هذه المقالة معًا قبل نشرها، وكل شخص يعمل على جزء مختلف منها.";

let sessions: TestSession[] = [];
let peers: HeadlessEditor[] = [];
let unmounts: Array<() => Promise<void>> = [];

beforeEach(async () => {
	resetTransportHealth();
	await cdp().send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
});
afterEach(async () => {
	// oxlint-disable-next-line no-await-in-loop -- React's act() calls must not overlap
	for (const unmount of unmounts) await unmount();
	for (const editor of peers) editor.destroy();
	for (const { session } of sessions) session.dispose();
	unmounts = [];
	peers = [];
	sessions = [];
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	resetTransportHealth();
});

const paragraph = (key: string, text: string): PortableTextBlock =>
	({
		_type: "block",
		_key: key,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
	}) as PortableTextBlock;

function roomWith(blocks: PortableTextBlock[]) {
	return new LoopbackRoom({
		seed: (doc) =>
			prosemirrorJSONToYXmlFragment(
				editorSchema(),
				portableTextToProsemirror(blocks, new Set()),
				doc.getXmlFragment(fragmentName("body")),
			),
	});
}

async function join(room: LoopbackRoom) {
	const session = startSession(room);
	sessions.push(session);
	await settle();
	const view = session.view();
	if (view.mode !== "room") throw new Error(`Expected a room, got ${view.mode}`);
	return Object.assign(session, { editing: view.room });
}

type Client = Awaited<ReturnType<typeof join>>;

/** The client's editor, in a field of its room as the content editor marks it. */
async function mount(
	client: Client,
	options: {
		width?: number;
		dir?: string;
		children?: React.ReactNode;
		onRender?: React.ProfilerOnRenderCallback;
	} = {},
): Promise<Editor> {
	const { width = 640, dir = "ltr", children, onRender = () => {} } = options;
	let editor: Editor | null = null;
	const screen = await render(
		<React.Profiler id={client.editing.id} onRender={onRender}>
			<div dir={dir} data-co-editing-room={client.editing.id} style={{ width }}>
				<div data-co-editing-field="body">
					<PortableTextEditor
						collaboration={client.editing.richText("body")}
						onEditorReady={(instance) => {
							editor ??= instance;
						}}
					/>
				</div>
				{children}
			</div>
		</React.Profiler>,
		{ container: adminRoot() },
	);
	unmounts.push(() => screen.unmount());
	await vi.waitFor(() => expect(editor).toBeTruthy());
	await settle();
	return editor!;
}

/** Another client typing straight into the room, without presence. */
function typist(room: LoopbackRoom): HeadlessEditor {
	const doc = room.peer();
	const editor = new HeadlessEditor({
		extensions: [
			...portableTextExtensions(),
			PortableTextFilledDefaults,
			PortableTextYSync,
			Extension.create({
				name: "peerSync",
				addProseMirrorPlugins: () => [ySyncPlugin(doc.getXmlFragment(fragmentName("body")))],
			}),
		],
	});
	peers.push(editor);
	return editor;
}

const caretIn = (editor: Editor) =>
	editor.view.dom.querySelector<HTMLElement>(".emdash-remote-caret");
const labelOf = (caret: HTMLElement | null) =>
	caret?.querySelector<HTMLElement>(".emdash-remote-caret-label") ?? null;
const shows = (editor: Editor) => {
	const label = labelOf(caretIn(editor));
	return label ? getComputedStyle(label).opacity === "1" : false;
};

describe("other people's carets", () => {
	it("show the person's name while their cursor moves and on hover, until 2.5 s after it stops", async () => {
		const room = roomWith([paragraph("k-a", "Alpha beta gamma"), paragraph("k-b", "Second line")]);
		const a = await join(room);
		const b = await join(room);
		const mine = await mount(a);
		const theirs = await mount(b);

		mine.chain().focus().setTextSelection(4).run();
		await vi.waitFor(() => expect(caretIn(theirs)).not.toBeNull());
		expect(labelOf(caretIn(theirs))?.textContent).toBe(`User ${a.replica().doc.clientID}`);
		expect(shows(theirs)).toBe(true);

		await b.after(CURSOR_LABEL_MS - 1);
		expect(shows(theirs)).toBe(true);
		await b.after(1);
		expect(shows(theirs)).toBe(false);

		mine.chain().setTextSelection(9).run();
		await vi.waitFor(() => expect(shows(theirs)).toBe(true));
		await b.after(CURSOR_LABEL_MS);
		expect(shows(theirs)).toBe(false);

		await userEvent.hover(caretIn(theirs)!, { force: true, position: { x: 1, y: 9 } });
		expect(shows(theirs)).toBe(true);
		await userEvent.unhover(caretIn(theirs)!, { force: true });
		expect(shows(theirs)).toBe(false);
	});

	it("never flash the name when anyone else types, though ProseMirror redraws the caret", async () => {
		const room = roomWith([paragraph("k-a", "Alpha beta gamma"), paragraph("k-b", "Second line")]);
		const a = await join(room);
		const b = await join(room);
		const mine = await mount(a);
		const theirs = await mount(b);
		const other = typist(room);
		mine.chain().focus().setTextSelection(9).run();
		await vi.waitFor(() => expect(caretIn(theirs)).not.toBeNull());
		await b.after(CURSOR_LABEL_MS);
		const drawn = caretIn(theirs);
		const seen: boolean[] = [];
		const observer = new MutationObserver(() => seen.push(shows(theirs)));
		observer.observe(theirs.view.dom, { subtree: true, childList: true, attributes: true });

		// Typing in this tab: an edit, and this client's own cursor moving with it.
		for (const at of [theirs.state.doc.content.size - 1, 3]) {
			theirs.commands.insertContentAt(at, "x");
			const sync = ySyncPluginKey.getState(theirs.state);
			const cursor = absolutePositionToRelativePosition(at + 1, sync.type, sync.binding.mapping);
			b.replica().awareness.setLocalStateField("cursor", { anchor: cursor, head: cursor });
			// oxlint-disable-next-line no-await-in-loop -- one keystroke at a time
			await settle();
		}
		// A third person formats the words around the caret, which redraws them.
		other.chain().setTextSelection({ from: 2, to: 14 }).toggleBold().run();
		await settle();
		observer.disconnect();

		expect(caretIn(theirs)).not.toBe(drawn);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((shown) => !shown)).toBe(true);
	});

	it("keep a right-to-left document right-to-left with a left-to-right name at its start", async () => {
		const room = roomWith([paragraph("k-a", ARABIC)]);
		const a = await join(room);
		const b = await join(room);
		const mine = await mount(a);
		const theirs = await mount(b, { dir: "rtl" });

		mine.chain().focus().setTextSelection(1).run();
		await vi.waitFor(() => expect(caretIn(theirs)).not.toBeNull());

		expect(getComputedStyle(theirs.view.dom).direction).toBe("rtl");
		const caret = caretIn(theirs)!.getBoundingClientRect();
		const label = labelOf(caretIn(theirs))!.getBoundingClientRect();
		expect(label.right).toBeCloseTo(caret.right, 0);
	});

	it("keep the name inside the editor at its inline end, in either direction", async () => {
		for (const [dir, text] of [
			["ltr", LONG],
			["rtl", ARABIC],
		] as const) {
			const room = roomWith([paragraph("k-a", text)]);
			const a = await join(room);
			const b = await join(room);
			const mine = await mount(a);
			// oxlint-disable-next-line no-await-in-loop -- one direction at a time
			const theirs = await mount(b, { width: 260, dir });
			const box = theirs.view.dom.getBoundingClientRect();
			const firstLine = theirs.view.coordsAtPos(1).top;
			let end = 1;
			for (let pos = 1; pos < theirs.state.doc.content.size; pos++) {
				if (Math.abs(theirs.view.coordsAtPos(pos).top - firstLine) < 2) end = pos;
			}

			mine
				.chain()
				.focus()
				.setTextSelection(end - 1)
				.run();
			// oxlint-disable-next-line no-await-in-loop -- one direction at a time
			await vi.waitFor(() => expect(caretIn(theirs)?.hasAttribute("data-shifted")).toBe(true));

			const caret = caretIn(theirs)!.getBoundingClientRect();
			const label = labelOf(caretIn(theirs))!.getBoundingClientRect();
			if (dir === "ltr") {
				expect(caret.left + label.width).toBeGreaterThan(box.right);
				expect(label.right).toBeLessThanOrEqual(box.right);
			} else {
				expect(caret.right - label.width).toBeLessThan(box.left);
				expect(label.left).toBeGreaterThanOrEqual(box.left);
			}
			expect(label.bottom).toBeLessThanOrEqual(caret.top + 1);
		}
	});

	it("draw each person's caret and selection in the color presence gives them", async () => {
		const room = roomWith([paragraph("k-a", "Alpha beta gamma")]);
		const a = await join(room);
		const b = await join(room);
		const mine = await mount(a);
		const theirs = await mount(b);

		mine.chain().focus().setTextSelection({ from: 2, to: 10 }).run();
		await vi.waitFor(() =>
			expect(theirs.view.dom.querySelector(".emdash-remote-selection")).not.toBeNull(),
		);

		const color = b.replica().presence.colorOf(`user-${a.replica().doc.clientID}`);
		expect(color).not.toBe("neutral");
		expect(caretIn(theirs)?.getAttribute("data-author-color")).toBe(color);
		const selection = theirs.view.dom.querySelector<HTMLElement>(".emdash-remote-selection")!;
		expect(selection.getAttribute("data-author-color")).toBe(color);
		expect(getComputedStyle(selection).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
	});

	it("change only ProseMirror's decorations when a cursor moves, never React", async () => {
		const room = roomWith([paragraph("k-a", LONG)]);
		const a = await join(room);
		const b = await join(room);
		const renders = new Map<string, number>();
		const count = (id: string) => () => renders.set(id, (renders.get(id) ?? 0) + 1);
		const mine = await mount(a);
		const label = (field: string) => (field === "body" ? "Body" : field);
		const theirs = await mount(b, {
			onRender: count("editor"),
			children: (
				<>
					<React.Profiler id="avatars" onRender={count("avatars")}>
						<PresenceAvatars room={b.editing} fieldLabel={label} />
					</React.Profiler>
					<React.Profiler id="body" onRender={count("body")}>
						<FieldPresence room={b.editing as RoomEditing} field="body" />
					</React.Profiler>
				</>
			),
		});
		mine.chain().focus().setTextSelection(3).run();
		await vi.waitFor(() => expect(caretIn(theirs)).not.toBeNull());
		await vi.waitFor(() =>
			expect(
				document.querySelector(`[aria-label="User ${a.replica().doc.clientID} · Editing Body"]`),
			).not.toBeNull(),
		);
		await settle();
		const before = new Map(renders);
		const caretMoves = vi.fn();
		b.editing.presence.subscribe(caretMoves);

		for (let position = 4; position < 12; position++) {
			mine.chain().setTextSelection(position).run();
			// oxlint-disable-next-line no-await-in-loop -- each move reaches the other client on its own
			await settle();
		}

		expect(caretIn(theirs)).not.toBeNull();
		expect(caretMoves).not.toHaveBeenCalled();
		expect(renders).toEqual(before);
	});
});

/** A CSS color as 8-bit sRGB, through a canvas so any color syntax works. */
function srgb(color: string): number[] {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const context = canvas.getContext("2d")!;
	context.fillStyle = color;
	context.fillRect(0, 0, 1, 1);
	const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
	return [red!, green!, blue!];
}

function contrast(a: string, b: string): number {
	const luminance = (color: string) => {
		const [red, green, blue] = srgb(color).map((value) => {
			const channel = value / 255;
			return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
	};
	const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
	return (high! + 0.05) / (low! + 0.05);
}

describe("a remote caret's color", () => {
	it.each(["light", "dark"])("keeps 3:1 against the editor in %s mode", async (mode) => {
		const colors = ["neutral", "purple", "teal", "blue", "orange"];
		const screen = await render(
			<div data-mode={mode} className="bg-kumo-base">
				<div className="ProseMirror">
					{colors.map((color) => (
						<span key={color} className="emdash-remote-caret" data-author-color={color}>
							x
						</span>
					))}
				</div>
			</div>,
		);
		unmounts.push(() => screen.unmount());
		const surface = screen.container.firstElementChild as HTMLElement;
		const background = getComputedStyle(surface).backgroundColor;
		const short = Array.from(
			surface.querySelectorAll<HTMLElement>(".emdash-remote-caret"),
			(caret) => ({
				color: caret.dataset.authorColor,
				ratio: contrast(getComputedStyle(caret).borderInlineStartColor, background),
			}),
		).filter(({ ratio }) => ratio < 3);
		expect(short).toEqual([]);
	});
});
