import {
	portableTextToProsemirror,
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import { Editor, type JSONContent } from "@tiptap/core";

import {
	INLINE_PLUGIN_BLOCK_TYPES,
	inlinePortableTextExtensions,
} from "../../src/components/inline-portable-text-schema.js";

const editors: Editor[] = [];

/** An editor with the inline editor's schema, holding `blocks` as the inline editor loads them. */
export function loadInline(
	blocks: PortableTextBlock[],
	options?: { tablePlaceholder?: string },
): Editor {
	const element = document.createElement("div");
	document.body.append(element);
	const editor = new Editor({
		element,
		extensions: inlinePortableTextExtensions(options),
		content: portableTextToProsemirror(blocks, INLINE_PLUGIN_BLOCK_TYPES) as JSONContent,
	});
	editors.push(editor);
	return editor;
}

/** The Portable Text the inline editor saves for `editor`'s document. */
export function saveInline(editor: Editor): PortableTextBlock[] {
	return prosemirrorToPortableText(editor.getJSON());
}

/** Loads `blocks` into the inline editor's schema and saves them again. */
export function roundTripInline(blocks: PortableTextBlock[]): PortableTextBlock[] {
	return saveInline(loadInline(blocks));
}

/** The editor document the inline editor holds after loading `blocks`. */
export function inlineDocument(blocks: unknown[]): JSONContent {
	return loadInline(blocks as PortableTextBlock[]).getJSON();
}

/**
 * The top-level nodes of `doc`, without the empty paragraph the editor keeps
 * after a final block.
 */
export function topLevelNodes(doc: JSONContent): JSONContent[] {
	const content = doc.content ?? [];
	const last = content.at(-1);
	return last?.type === "paragraph" && !last.content?.length ? content.slice(0, -1) : content;
}

/** The Portable Text the inline editor saves for an editor document. */
export function saveDocument(doc: JSONContent): PortableTextBlock[] {
	return prosemirrorToPortableText(doc as Parameters<typeof prosemirrorToPortableText>[0]);
}

/** Destroys every editor `loadInline` made. Call from `afterEach`. */
export function destroyInlineEditors(): void {
	for (const editor of editors.splice(0)) {
		const element = editor.options.element;
		editor.destroy();
		if (element instanceof HTMLElement) element.remove();
	}
}
