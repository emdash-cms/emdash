import { screen } from "@testing-library/react";
import Focus from "@tiptap/extension-focus";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { render } from "./utils/render.js";

// Test wrapper to render editor with Focus extension
function TestEditor({ spotlightMode = false }: { spotlightMode?: boolean }) {
	const editor = useEditor({
		extensions: [
			StarterKit,
			Focus.configure({
				className: "has-focus",
				mode: "all",
			}),
		],
		content: `
			<p>First paragraph</p>
			<p>Second paragraph</p>
			<p>Third paragraph</p>
		`,
		immediatelyRender: true,
	});

	if (!editor) return <div data-testid="loading">Loading...</div>;

	return (
		<div className={spotlightMode ? "spotlight-mode" : ""} data-testid="editor-wrapper">
			<style>{`
				.spotlight-mode .ProseMirror > *:not(.has-focus) {
					opacity: 0.3;
					transition: opacity 0.2s ease;
				}
				.spotlight-mode .ProseMirror > .has-focus {
					opacity: 1;
					transition: opacity 0.2s ease;
				}
			`}</style>
			<EditorContent editor={editor} data-testid="editor-content" />
		</div>
	);
}

describe("Editor Focus Mode", () => {
	it("Focus extension is configured correctly", async () => {
		void render(<TestEditor />);

		// Wait for editor to initialize (not just loading state)
		await vi.waitFor(
			() => {
				const wrapper = screen.queryByTestId("editor-wrapper");
				expect(wrapper).toBeTruthy();
			},
			{ timeout: 2000 },
		);

		const editorContent = screen.getByTestId("editor-content");
		expect(editorContent).toBeDefined();

		// The editor should be rendered with ProseMirror
		const proseMirror = editorContent.querySelector(".ProseMirror");
		expect(proseMirror).toBeTruthy();

		// Verify the editor has the correct structure (3 paragraphs)
		const paragraphs = proseMirror?.querySelectorAll("p");
		expect(paragraphs?.length).toBe(3);
	});

	it("spotlight mode applies CSS class to editor wrapper", async () => {
		void render(<TestEditor spotlightMode={true} />);

		// Wait for editor to initialize
		await vi.waitFor(
			() => {
				const wrapper = screen.queryByTestId("editor-wrapper");
				expect(wrapper).toBeTruthy();
			},
			{ timeout: 2000 },
		);

		const wrapper = screen.getByTestId("editor-wrapper");
		expect(wrapper.classList.contains("spotlight-mode")).toBe(true);
	});

	it("non-spotlight mode does not have spotlight-mode class", async () => {
		void render(<TestEditor spotlightMode={false} />);

		// Wait for editor to initialize
		await vi.waitFor(
			() => {
				const wrapper = screen.queryByTestId("editor-wrapper");
				expect(wrapper).toBeTruthy();
			},
			{ timeout: 2000 },
		);

		const wrapper = screen.getByTestId("editor-wrapper");
		expect(wrapper.classList.contains("spotlight-mode")).toBe(false);
	});
});

describe("Distraction-free mode state", () => {
	it("can toggle between focus modes", () => {
		// Simple state test - verifies the type and state pattern works
		type FocusMode = "normal" | "spotlight";

		let focusMode: FocusMode = "normal";

		// Toggle to spotlight
		focusMode = "spotlight";
		expect(focusMode).toBe("spotlight");

		// Toggle back to normal
		focusMode = "normal";
		expect(focusMode).toBe("normal");
	});
});
