/**
 * The editor's undo history: prosemirror-history in a single editor, and
 * Collaboration's Y.UndoManager in a room, where prosemirror-history's own
 * functions find no history.
 */

import { closeHistory, undo, undoDepth } from "@tiptap/pm/history";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { UndoManager } from "yjs";

import { yPluginKeys } from "./y-plugin-keys.js";

function undoManager(state: EditorState): UndoManager | undefined {
	return yPluginKeys(state)?.undo.getState(state)?.undoManager;
}

/** The number of undo steps the history holds. */
export function historyDepth(state: EditorState): number {
	const manager = undoManager(state);
	return manager ? manager.undoStack.length : undoDepth(state);
}

/** Makes `tr` start a new undo step, so it doesn't join the one before it. */
export function closeHistoryGroup(state: EditorState, tr: Transaction): Transaction {
	const manager = undoManager(state);
	if (!manager) return closeHistory(tr);
	manager.stopCapturing();
	return tr;
}

/**
 * Ends the current undo step, so the next local change starts its own. Y.UndoManager groups local
 * changes by time alone; prosemirror-history already starts a step for a change that isn't next to
 * the last one.
 */
export function endHistoryGroup(state: EditorState): void {
	undoManager(state)?.stopCapturing();
}

/**
 * Undoes the last undo step. Y.UndoManager renders its undo through the
 * binding itself, so `dispatch` only receives prosemirror-history's.
 */
export function undoLastGroup(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
	const manager = undoManager(state);
	if (!manager) return undo(state, dispatch);
	if (manager.undoStack.length === 0) return false;
	manager.undo();
	return true;
}
