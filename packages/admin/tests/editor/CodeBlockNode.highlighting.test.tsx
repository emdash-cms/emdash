import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { CodeBlockExtension } from "../../src/components/editor/CodeBlockNode";
import { render } from "../utils/render.js";

import "../../src/styles.css";

function CodeEditor({
	language,
	code,
	onEditor,
}: {
	language: string | null | undefined;
	code: string;
	onEditor?: (editor: Editor) => void;
}) {
	const editor = useEditor({
		extensions: [StarterKit.configure({ codeBlock: false }), CodeBlockExtension],
		content: {
			type: "doc",
			content: [
				{ type: "codeBlock", attrs: { language }, content: [{ type: "text", text: code }] },
			],
		},
		immediatelyRender: true,
	});

	useEffect(() => {
		if (editor) onEditor?.(editor);
	}, [editor, onEditor]);
	return <EditorContent editor={editor} />;
}

describe("CodeBlockExtension highlighting", () => {
	it.each([
		["javascript", 'const greeting = "hello";'],
		["dockerfile", "FROM node:22"],
	])("renders syntax tokens for %s", async (language, code) => {
		let editor: Editor | undefined;
		const screen = await render(
			<CodeEditor language={language} code={code} onEditor={(instance) => (editor = instance)} />,
		);

		await vi.waitFor(() => {
			expect(screen.container.querySelector("code")?.textContent).toBe(code);
			expect(screen.container.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
		});

		expect(JSON.stringify(editor!.getJSON())).not.toContain("hljs-");
	});

	it.each(["plaintext", "astro", "zig", "custom-language", null, undefined])(
		"leaves %s code unhighlighted",
		async (language) => {
			const screen = await render(
				<CodeEditor language={language} code={'const greeting = "hello";'} />,
			);

			await vi.waitFor(() => {
				expect(screen.container.querySelector("code")?.textContent).toBe(
					'const greeting = "hello";',
				);
			});
			expect(screen.container.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0);
		},
	);

	it("updates decorations when the selected language changes", async () => {
		let editor: Editor | undefined;
		const screen = await render(
			<CodeEditor
				language="javascript"
				code={'const greeting = "hello";'}
				onEditor={(instance) => (editor = instance)}
			/>,
		);
		const editorElement = screen.container.querySelector(".ProseMirror")!;

		await vi.waitFor(() => {
			expect(editorElement.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
		});

		editor!.commands.setNodeSelection(0);
		editor!.commands.updateAttributes("codeBlock", { language: "astro" });
		await vi.waitFor(() => {
			expect(editorElement.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0);
		});
		expect(editor!.getJSON().content?.[0]?.content?.[0]?.text).toBe('const greeting = "hello";');
	});
});
