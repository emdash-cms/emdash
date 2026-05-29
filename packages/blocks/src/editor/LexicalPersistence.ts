import type { LexicalEditor } from "lexical";

/**
 * Persists Lexical editor state to a JSON blob.
 * The consumer is responsible for storing/retrieving the blob from their storage layer (D1, SQLite, etc.).
 *
 * Usage:
 *   // Save (on change)
 *   const json = LexicalPersistence.serialize(editor);
 *   await saveToD1(pageId, json);
 *
 *   // Load (on mount)
 *   const json = await loadFromD1(pageId);
 *   if (json) LexicalPersistence.restore(editor, json);
 */
export const LexicalPersistence = {
	/**
	 * Serialize the current editor state to a JSON string.
	 * Call this on change (debounced) to get the persistent representation.
	 */
	serialize(editor: LexicalEditor): string {
		const editorState = editor.getEditorState();
		return JSON.stringify(editorState.toJSON());
	},

	/**
	 * Restore editor state from a JSON string previously obtained via serialize().
	 * Safely handles empty/null input by doing nothing.
	 */
	restore(editor: LexicalEditor, json: string | null | undefined): void {
		if (!json) return;
		try {
			const parsed = JSON.parse(json);
			const newState = editor.parseEditorState(parsed);
			editor.setEditorState(newState);
		} catch (err) {
			console.error("[LexicalPersistence] Failed to restore state:", err);
		}
	},
};
