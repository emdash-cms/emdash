/**
 * y-tiptap's plugin keys, read through a plugin a room's rich-text binding adds. Editor code that
 * sites also load on the server, through `portableTextExtensions()`, reads them here instead of
 * importing y-tiptap.
 */

import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";

export interface YPluginKeys {
	readonly sync: typeof ySyncPluginKey;
	readonly undo: typeof yUndoPluginKey;
}

const Y_PLUGIN_KEYS = new PluginKey<YPluginKeys>("emdashYPluginKeys");

/** The plugin that makes `keys` readable in an editor bound to a room. */
export function yPluginKeysPlugin(keys: YPluginKeys): Plugin<YPluginKeys> {
	return new Plugin({
		key: Y_PLUGIN_KEYS,
		state: { init: () => keys, apply: (_tr, value) => value },
	});
}

/** y-tiptap's plugin keys, in an editor bound to a room. */
export function yPluginKeys(state: EditorState): YPluginKeys | undefined {
	return Y_PLUGIN_KEYS.getState(state);
}
