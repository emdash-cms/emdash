// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { _createUnsupportedFileHandlers as createUnsupportedFileHandlers } from "../../../src/components/InlinePortableTextEditor.js";

function fileList(...files: File[]): FileList {
	const list = {
		length: files.length,
		item: (index: number) => files[index] ?? null,
	} as unknown as FileList;
	files.forEach((file, index) => Object.defineProperty(list, index, { value: file }));
	return list;
}

function dropEvent(files: File[]): DragEvent {
	return {
		dataTransfer: { files: fileList(...files), items: { length: 0 } },
		preventDefault: vi.fn(),
	} as unknown as DragEvent;
}

function pasteEvent(files: File[]): ClipboardEvent {
	return {
		clipboardData: { files: fileList(...files), items: { length: 0 } },
		preventDefault: vi.fn(),
	} as unknown as ClipboardEvent;
}

describe("inline editor file transfers", () => {
	it("refuses file drops before the browser can navigate away", () => {
		const showGuidance = vi.fn();
		const handlers = createUnsupportedFileHandlers(showGuidance);
		const event = dropEvent([new File(["image"], "photo.png", { type: "image/png" })]);

		expect(handlers.handleDOMEvents.drop({} as never, event)).toBe(true);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(showGuidance).toHaveBeenCalledOnce();
	});

	it("keeps file drags inside the editor until they can be refused", () => {
		const showGuidance = vi.fn();
		const handlers = createUnsupportedFileHandlers(showGuidance);
		const dragEnter = dropEvent([new File(["image"], "photo.png", { type: "image/png" })]);
		const dragOver = dropEvent([new File(["image"], "photo.png", { type: "image/png" })]);

		expect(handlers.handleDOMEvents.dragenter({} as never, dragEnter)).toBe(true);
		expect(handlers.handleDOMEvents.dragover({} as never, dragOver)).toBe(true);
		expect(dragEnter.preventDefault).toHaveBeenCalledOnce();
		expect(dragOver.preventDefault).toHaveBeenCalledOnce();
		expect(showGuidance).not.toHaveBeenCalled();
	});

	it("refuses files pasted from the clipboard", () => {
		const showGuidance = vi.fn();
		const handlers = createUnsupportedFileHandlers(showGuidance);
		const event = pasteEvent([new File(["document"], "notes.pdf", { type: "application/pdf" })]);

		expect(handlers.handleDOMEvents.paste({} as never, event)).toBe(true);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(showGuidance).toHaveBeenCalledOnce();
	});

	it("recognizes an indexed file item when the browser leaves files empty", () => {
		const showGuidance = vi.fn();
		const handlers = createUnsupportedFileHandlers(showGuidance);
		const event = dropEvent([]);
		Object.defineProperty(event.dataTransfer, "items", {
			value: { 0: { kind: "file" }, length: 1 },
		});

		expect(handlers.handleDOMEvents.drop({} as never, event)).toBe(true);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(showGuidance).toHaveBeenCalledOnce();
	});

	it("leaves ordinary editor drop and paste behavior untouched", () => {
		const showGuidance = vi.fn();
		const handlers = createUnsupportedFileHandlers(showGuidance);
		const drop = dropEvent([]);
		const paste = pasteEvent([]);

		expect(handlers.handleDOMEvents.drop({} as never, drop)).toBe(false);
		expect(handlers.handleDOMEvents.paste({} as never, paste)).toBe(false);
		expect(drop.preventDefault).not.toHaveBeenCalled();
		expect(paste.preventDefault).not.toHaveBeenCalled();
		expect(showGuidance).not.toHaveBeenCalled();
	});
});
