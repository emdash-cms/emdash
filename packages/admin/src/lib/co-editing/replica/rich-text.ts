import { Extension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { yCursorPlugin, ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";

import { fragmentName } from "../../../co-editing/layout.js";
import { yPluginKeysPlugin } from "../../../components/editor/y-plugin-keys.js";
import type { RichTextBinding } from "../types.js";
import type { Replica } from "./replica.js";

/**
 * What a rich-text field's editor mounts with in a room: the field's fragment, with
 * Collaboration's undo, y-tiptap's plugin keys for the editor's own plugins, the other clients'
 * cursors, and a registration that tells the replica which editor renders the field.
 */
export function createRichTextBinding(replica: Replica, field: string): RichTextBinding {
	return {
		extensions: [
			Collaboration.configure({ fragment: replica.doc.getXmlFragment(fragmentName(field)) }),
			Extension.create({
				name: "coEditingPluginKeys",
				addProseMirrorPlugins: () => [
					yPluginKeysPlugin({ sync: ySyncPluginKey, undo: yUndoPluginKey }),
				],
			}),
			Extension.create({
				name: "coEditingCursors",
				addProseMirrorPlugins: () => [
					yCursorPlugin(replica.awareness, {
						cursorBuilder: replica.cursors.caret,
						selectionBuilder: replica.cursors.selection,
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
