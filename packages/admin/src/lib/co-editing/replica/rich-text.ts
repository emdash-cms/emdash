import { Extension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { yCursorPlugin } from "@tiptap/y-tiptap";

import { fragmentName } from "../../../co-editing/layout.js";
import type { RichTextBinding } from "../types.js";
import type { Replica } from "./replica.js";

/**
 * What a rich-text field's editor mounts with in a room: the field's fragment, with
 * Collaboration's undo, the other clients' cursors, and a registration that tells the replica
 * which editor renders the field.
 */
export function createRichTextBinding(replica: Replica, field: string): RichTextBinding {
	return {
		extensions: [
			Collaboration.configure({ fragment: replica.doc.getXmlFragment(fragmentName(field)) }),
			Extension.create({
				name: "coEditingCursors",
				addProseMirrorPlugins: () => [
					yCursorPlugin(replica.awareness, {
						cursorBuilder: remoteCaret,
						selectionBuilder: () => ({
							class: "emdash-remote-selection",
							"data-author-color": "",
						}),
					}),
				],
			}),
			Extension.create<unknown, { unregister: (() => void) | null }>({
				name: "coEditingRegistration",
				addStorage: () => ({ unregister: null }),
				onCreate() {
					this.storage.unregister = replica.registerEditor(field, this.editor);
				},
				onDestroy() {
					this.storage.unregister?.();
				},
			}),
		],
	};
}

function remoteCaret(user: { name?: unknown }): HTMLElement {
	const caret = document.createElement("span");
	caret.className = "emdash-remote-caret";
	caret.setAttribute("data-author-color", "");
	const label = document.createElement("span");
	label.className = "emdash-remote-caret-label";
	label.textContent = typeof user.name === "string" ? user.name : "";
	// Word joiners keep the caret from opening a line break where it sits.
	caret.append("\u2060", label, "\u2060");
	return caret;
}
