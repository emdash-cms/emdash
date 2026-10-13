import { screen } from "@testing-library/react";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { ImageExtension } from "../../src/components/editor/ImageNode.js";
import { render } from "../utils/render.js";

function TestEditor({ onReady }: { onReady: (editor: Editor) => void }) {
	const editor = useEditor({
		extensions: [StarterKit, ImageExtension],
		content: {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
				{ type: "image", attrs: { src: "/img.jpg", alt: "Example" } },
			],
		},
		immediatelyRender: true,
	});
	React.useEffect(() => {
		if (editor) onReady(editor);
	}, [editor, onReady]);

	if (!editor) return null;
	return <EditorContent editor={editor} />;
}

function pressWithPointerDrift(target: HTMLElement) {
	const rect = target.getBoundingClientRect();
	const clientX = rect.left + rect.width / 2;
	const clientY = rect.top + rect.height / 2;
	const pointer = {
		bubbles: true,
		button: 0,
		buttons: 1,
		clientX,
		clientY,
		isPrimary: true,
		pointerId: 1,
		pointerType: "mouse",
	};

	target.dispatchEvent(new PointerEvent("pointerdown", pointer));
	target.dispatchEvent(new MouseEvent("mousedown", pointer));
	document.dispatchEvent(new MouseEvent("mousemove", { ...pointer, clientX: clientX + 6 }));
	target.dispatchEvent(
		new PointerEvent("pointerup", { ...pointer, buttons: 0, clientX: clientX + 6 }),
	);
	target.dispatchEvent(new MouseEvent("mouseup", { ...pointer, buttons: 0, clientX: clientX + 6 }));
}

describe("Editor image selection", () => {
	it("selects the image after a primary press with slight pointer drift", async () => {
		let editor: Editor | undefined;
		void render(
			<TestEditor
				onReady={(instance) => {
					editor = instance;
				}}
			/>,
		);
		const image = await screen.findByRole("img", { name: "Example" });
		await vi.waitFor(() => expect(editor).toBeDefined());

		pressWithPointerDrift(image);

		await vi.waitFor(() => {
			const { selection } = editor!.state;
			expect(selection instanceof NodeSelection && selection.node.type.name === "image").toBe(true);
		});
	});
});
