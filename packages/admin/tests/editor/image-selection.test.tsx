import { screen } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { ImageExtension } from "../../src/components/editor/ImageNode.js";
import { render } from "../utils/render.js";

function TestEditor({ onSidebarOpen }: { onSidebarOpen?: (panel: unknown) => void } = {}) {
	const editor = useEditor({
		extensions: [StarterKit, ImageExtension],
		content: {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
				{
					type: "image",
					attrs: { src: "/img.jpg", alt: "Example", provider: "cloudflare-images" },
				},
			],
		},
		immediatelyRender: true,
	});
	React.useEffect(() => {
		if (!editor || !onSidebarOpen) return;
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).image;
		if (!storage) return;
		storage.onOpenBlockSidebar = onSidebarOpen;
		return () => {
			storage.onOpenBlockSidebar = null;
		};
	}, [editor, onSidebarOpen]);

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
	it("shows image actions after a primary press with slight pointer drift", async () => {
		void render(<TestEditor />);
		const image = await screen.findByRole("img", { name: "Example" });

		expect(screen.queryByRole("button", { name: "Image settings" })).toBeNull();
		pressWithPointerDrift(image);

		const settings = await screen.findByRole("button", { name: "Image settings" });
		expect(getComputedStyle(settings.parentElement!).opacity).toBe("1");
	});

	it("passes the image provider to the settings sidebar", async () => {
		const onSidebarOpen = vi.fn();
		void render(<TestEditor onSidebarOpen={onSidebarOpen} />);
		const image = await screen.findByRole("img", { name: "Example" });

		pressWithPointerDrift(image);
		(await screen.findByRole("button", { name: "Image settings" })).click();

		await vi.waitFor(() => expect(onSidebarOpen).toHaveBeenCalledOnce());
		expect(onSidebarOpen.mock.calls[0]?.[0]).toMatchObject({
			attrs: { provider: "cloudflare-images" },
		});
	});
});
