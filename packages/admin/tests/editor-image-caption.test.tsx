import { screen } from "@testing-library/react";
import { useEditor, EditorContent, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { TopBlockDocument } from "../src/components/editor/EmbedBlockShell.js";
import { ImageExtension } from "../src/components/editor/ImageNode.js";
import { VideoExtension } from "../src/components/editor/VideoNode.js";
import { render } from "./utils/render.js";

// Newer @tiptap/react releases hand a node view its changed attributes a
// microtask later. Delay them here too, so the locked version behaves the same.
vi.mock("@tiptap/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tiptap/react")>();
	const ReactNodeViewRenderer: typeof actual.ReactNodeViewRenderer = (Component, options) =>
		actual.ReactNodeViewRenderer(
			(props: NodeViewProps) => (
				<Component
					{...props}
					updateAttributes={(attrs) => queueMicrotask(() => props.updateAttributes(attrs))}
				/>
			),
			options,
		);
	return { ...actual, ReactNodeViewRenderer };
});

// The editor figcaption must mirror the published renderer (Image.astro):
// caption only — alt text must not display as a visible caption.
function TestEditor({
	attrs,
	editable = true,
	type = "image",
}: {
	attrs: Record<string, string>;
	editable?: boolean;
	type?: "image" | "videoBlock";
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
			content: [{ type, attrs }],
		},
		editable,
		immediatelyRender: true,
	});

	if (!editor) return <div data-testid="loading">Loading...</div>;
	return <EditorContent editor={editor} data-testid="editor-content" />;
}

describe("Editor image caption display", () => {
	it("edits the caption in a field under the image", async () => {
		void render(<TestEditor attrs={{ src: "/img.jpg", caption: "A real caption" }} />);
		const caption = await screen.findByRole("textbox", { name: "Caption" });
		expect(caption).toHaveValue("A real caption");
		expect(caption.closest("figcaption")).not.toBeNull();
	});

	it.each(["image", "videoBlock"] as const)(
		"keeps the cursor where the editor is typing in the %s caption",
		async (type) => {
			void render(
				<TestEditor type={type} attrs={{ src: "/img.jpg", caption: "Keeneland Race Course" }} />,
			);
			const caption = (await screen.findByRole("textbox", {
				name: "Caption",
			})) as HTMLTextAreaElement;
			caption.focus();
			caption.setSelectionRange(0, 0);
			await userEvent.keyboard("The Paddock ");
			expect(caption).toHaveValue("The Paddock Keeneland Race Course");
			expect(caption.selectionStart).toBe("The Paddock ".length);
		},
	);

	it("does NOT render alt text as a caption (WYSIWYG parity with Image.astro)", async () => {
		void render(<TestEditor attrs={{ src: "/img.jpg", alt: "Alt text only" }} />);
		// the image itself renders with the alt attribute…
		await screen.findByAltText("Alt text only");
		// …but the caption stays empty and shows its placeholder
		const caption = screen.getByRole("textbox", { name: "Caption" });
		expect(caption).toHaveValue("");
		expect(caption).toHaveAttribute("placeholder", "Type caption for image (optional)");
		expect(screen.queryByText("Alt text only")).toBeNull();
	});

	it("prefers the caption over alt when both are set", async () => {
		void render(<TestEditor attrs={{ src: "/img.jpg", alt: "The alt", caption: "The caption" }} />);
		expect(await screen.findByRole("textbox", { name: "Caption" })).toHaveValue("The caption");
		expect(screen.queryByText("The alt")).toBeNull();
	});

	it("shows the caption as text, and no field, when the editor is read-only", async () => {
		const { unmount } = await render(
			<TestEditor attrs={{ src: "/img.jpg", caption: "Read only" }} editable={false} />,
		);
		const caption = await screen.findByText("Read only");
		expect(caption.tagName.toLowerCase()).toBe("figcaption");
		expect(screen.queryByRole("textbox", { name: "Caption" })).toBeNull();
		await unmount();

		void render(<TestEditor attrs={{ src: "/img.jpg", alt: "Uncaptioned" }} editable={false} />);
		await screen.findByAltText("Uncaptioned");
		expect(document.querySelector("figcaption")).toBeNull();
	});
});
