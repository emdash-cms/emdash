import type { LexicalEditor } from "lexical";
import { useEffect, useRef, useCallback } from "react";

import { LexicalPersistence } from "./LexicalPersistence.js";

interface UseLexicalPersistenceOptions {
	editor: LexicalEditor | null;
	onSave: (json: string) => Promise<void>;
	debounceMs?: number;
}

/**
 * Hook that persists Lexical editor state to an external storage (e.g. D1).
 * Debounces saves to avoid hammering the database on every keystroke.
 *
 * Usage:
 *   const { save } = useLexicalPersistence({
 *     editor,
 *     onSave: async (json) => { await db.updateContent(pageId, json); },
 *     debounceMs: 500,
 *   });
 */
export function useLexicalPersistence({
	editor,
	onSave,
	debounceMs = 500,
}: UseLexicalPersistenceOptions) {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const save = useCallback(
		(json: string) => {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				onSave(json).catch((err) => {
					console.error("[LexicalPersistence] Save failed:", err);
				});
			}, debounceMs);
		},
		[onSave, debounceMs],
	);

	useEffect(() => {
		if (!editor) return;

		const cancel = editor.registerUpdateListener(({ editorState }) => {
			const json = JSON.stringify(editorState.toJSON());
			save(json);
		});

		return () => {
			cancel();
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [editor, save]);

	const flush = useCallback(() => {
		if (!editor) return;
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		const json = LexicalPersistence.serialize(editor);
		onSave(json).catch((err) => {
			console.error("[LexicalPersistence] Flush save failed:", err);
		});
	}, [editor, onSave]);

	return { flush };
}
