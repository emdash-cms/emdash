import { screen } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, it, expect } from "vitest";

import { ImageExtension } from "../src/components/editor/ImageNode.js";
import { render } from "./utils/render.js";

// The editor figcaption must mirror the published renderer (Image.astro):
// caption only — alt text must not display as a visible caption.
function TestEditor({ attrs }: { attrs: Record<string, string> }) {
	const editor = useEditor({
		extensions: [StarterKit, ImageExtension],
		content: {
			type: "doc",
			content: [{ type: "image", attrs }],
		},
		immediatelyRender: true,
	});

	if (!editor) return <div data-testid="loading">Loading...</div>;
	return <EditorContent editor={editor} data-testid="editor-content" />;
}

describe("Editor image caption display", () => {
	it("shows a figcaption when the image has a caption", async () => {
		void render(<TestEditor attrs={{ src: "/img.jpg", caption: "A real caption" }} />);
		const caption = await screen.findByText("A real caption");
		expect(caption.tagName.toLowerCase()).toBe("figcaption");
	});

	it("does NOT render alt text as a caption (WYSIWYG parity with Image.astro)", async () => {
		void render(<TestEditor attrs={{ src: "/img.jpg", alt: "Alt text only" }} />);
		// the image itself renders with the alt attribute…
		await screen.findByAltText("Alt text only");
		// …but no visible figcaption is shown for it
		expect(screen.queryByText("Alt text only")).toBeNull();
	});

	it("prefers the caption over alt when both are set", async () => {
		void render(<TestEditor attrs={{ src: "/img.jpg", alt: "The alt", caption: "The caption" }} />);
		const caption = await screen.findByText("The caption");
		expect(caption.tagName.toLowerCase()).toBe("figcaption");
		expect(screen.queryByText("The alt")).toBeNull();
	});
});
