import { screen } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, it, expect } from "vitest";

import { ImageExtension } from "../src/components/editor/ImageNode.js";
import { render } from "./utils/render.js";

// The editor figcaption must mirror the published renderer (Image.astro):
// caption only — alt text must not display as a visible caption.
function TestEditor({
	attrs,
	editable = true,
}: {
	attrs: Record<string, string>;
	editable?: boolean;
}) {
	const editor = useEditor({
		extensions: [StarterKit, ImageExtension],
		content: {
			type: "doc",
			content: [{ type: "image", attrs }],
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
