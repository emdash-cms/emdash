import { EditorContent, useEditor, type Editor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

// Keep node attributes stale until the input event ends, even on older TipTap versions.
vi.mock("@tiptap/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tiptap/react")>();
	const ReactNodeViewRenderer: typeof actual.ReactNodeViewRenderer = (Component, options) =>
		actual.ReactNodeViewRenderer(
			(props: NodeViewProps) => (
				<Component
					{...props}
					updateAttributes={(attrs) => {
						queueMicrotask(() => props.updateAttributes(attrs));
					}}
				/>
			),
			options,
		);
	return { ...actual, ReactNodeViewRenderer };
});

import { TopBlockDocument } from "../../src/components/editor/EmbedBlockShell.js";
import { ImageExtension } from "../../src/components/editor/ImageNode.js";
import { VideoExtension } from "../../src/components/editor/VideoNode.js";
import { render } from "../utils/render.js";

type Case = {
	name: "image" | "videoBlock";
	source: string;
};

const cases: Case[] = [
	{
		name: "image",
		source: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
	},
	{ name: "videoBlock", source: "" },
];

function EditorFixture({
	testCase,
	onCreate,
}: {
	testCase: Case;
	onCreate: (editor: Editor) => void;
}) {
	const editor = useEditor({
		extensions: [
			StarterKit.configure({ document: false }),
			TopBlockDocument,
			ImageExtension,
			VideoExtension,
		],
		content: {
			type: "doc",
			content: [
				{ type: testCase.name, attrs: { src: testCase.source, caption: "Keeneland Race Course" } },
				{ type: "paragraph" },
			],
		},
		onCreate: ({ editor: instance }) => onCreate(instance),
	});

	return editor ? <EditorContent editor={editor} /> : null;
}

async function setup(testCase: Case) {
	let editor: Editor | undefined;
	const screen = await render(
		<EditorFixture testCase={testCase} onCreate={(value) => (editor = value)} />,
	);
	await vi.waitFor(() => expect(editor).toBeDefined());
	const caption = screen.getByRole("textbox", { name: "Caption" }).element() as HTMLTextAreaElement;
	return { caption, editor: editor!, screen };
}

describe.each(cases)("$name caption input", (testCase) => {
	it("keeps the caret at the insertion point when typing at the start", async () => {
		const { caption, editor } = await setup(testCase);
		caption.focus();
		caption.setSelectionRange(0, 0);
		await userEvent.type(caption, "The ");

		expect(caption).toHaveValue("The Keeneland Race Course");
		expect(caption.selectionStart).toBe(4);
		expect(caption.selectionEnd).toBe(4);
		expect(editor.getJSON().content?.[0]?.attrs?.caption).toBe("The Keeneland Race Course");
	});

	it("keeps the caret at the insertion point when typing in the middle", async () => {
		const { caption, editor } = await setup(testCase);
		caption.focus();
		caption.setSelectionRange(9, 9);
		await userEvent.type(caption, " Central");

		expect(caption).toHaveValue("Keeneland Central Race Course");
		expect(caption.selectionStart).toBe(17);
		expect(caption.selectionEnd).toBe(17);
		expect(editor.getJSON().content?.[0]?.attrs?.caption).toBe("Keeneland Central Race Course");
	});

	it("keeps the caret after replacing a selection and accepts an external update", async () => {
		const { caption, editor } = await setup(testCase);
		caption.focus();
		caption.setSelectionRange(0, 9);
		await userEvent.type(caption, "The Paddock");

		expect(caption).toHaveValue("The Paddock Race Course");
		expect(caption.selectionStart).toBe(11);
		expect(caption.selectionEnd).toBe(11);
		expect(editor.getJSON().content?.[0]?.attrs?.caption).toBe("The Paddock Race Course");

		editor.commands.updateAttributes(testCase.name, { caption: "Restored caption" });
		await vi.waitFor(() => expect(caption).toHaveValue("Restored caption"));
		expect(caption).toHaveFocus();
	});
});
