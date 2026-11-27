/**
 * Editorial comments in the inline editor. The visual editing toolbar loads
 * the threads and shows them in its popover; the editor highlights the ones on
 * its field, starts new ones from a selection and keeps their anchors in step
 * with its saves. The two talk through document events, so a page without the
 * toolbar's comments gets no highlights and no Comment button.
 */

import {
	anchorForRange,
	anchorForSelection,
	generateKey,
	getEditorialHighlights,
	locateAnchor,
	sameAnchor,
	setEditorialHighlights,
	type EditorialAnchor,
	type EditorialCommentsBridge,
	type EditorialHighlight,
	type SelectionAnchorResult,
} from "@emdash-cms/admin/internal/editorial-editor";
import type { Editor } from "@tiptap/core";
import * as React from "react";

export const EDITORIAL_EVENTS = {
	/** Editor → toolbar: `{ collection, id, field, element }` once the editor is on the page. */
	ready: "emdash:inline-editor-ready",
	/** Toolbar → editors: comments have started, so editors already on the page announce themselves. */
	start: "emdash:editorial-comments-start",
	/** Toolbar → editor: `{ collection, id, field, threads, labels }`, the field's open threads. */
	threads: "emdash:editorial-threads",
	/** Editor → toolbar: `{ collection, id, field, threadId }` or `{ ..., draft: { anchor } }`. */
	open: "emdash:editorial-open",
	/** Toolbar → editor: `{ collection, id, field }` when its popover closes. */
	closed: "emdash:editorial-closed",
	/** Editor → toolbar: `{ collection, id }` after it moved thread anchors. */
	anchorsChanged: "emdash:editorial-anchors-changed",
} as const;

export interface InlineEditorialLabels {
	commentOnSelection: string;
	selectionTooLong: string;
	selectionOneParagraph: string;
	selectionUnsupported: string;
	selectionUnkeyed: string;
}

interface InlineThread {
	id: string;
	status: string;
	anchor: EditorialAnchor;
	anchorState?: "attached" | "orphaned";
}

interface EditorialEventDetail {
	collection?: unknown;
	id?: unknown;
	field?: unknown;
	threads?: unknown;
	labels?: unknown;
}

const ANCHOR_BATCH_SIZE = 100;

const REASON_LABELS: Record<
	Extract<SelectionAnchorResult, { ok: false }>["reason"],
	keyof InlineEditorialLabels
> = {
	"too-long": "selectionTooLong",
	empty: "selectionOneParagraph",
	"multiple-blocks": "selectionOneParagraph",
	unsupported: "selectionUnsupported",
	unkeyed: "selectionUnkeyed",
};

function isFieldAnchor(anchor: EditorialAnchor, field: string): boolean {
	return (anchor.type === "text" || anchor.type === "block") && anchor.field === field;
}

const LABEL_KEYS: Array<keyof InlineEditorialLabels> = [
	"commentOnSelection",
	"selectionTooLong",
	"selectionOneParagraph",
	"selectionUnsupported",
	"selectionUnkeyed",
];

function isLabels(value: unknown): value is InlineEditorialLabels {
	if (!value || typeof value !== "object") return false;
	return LABEL_KEYS.every((key) => typeof Reflect.get(value, key) === "string");
}

function eventDetail(event: Event): EditorialEventDetail | null {
	if (!(event instanceof CustomEvent)) return null;
	const detail: unknown = event.detail;
	return detail && typeof detail === "object" ? detail : null;
}

function isThreads(value: unknown): value is InlineThread[] {
	return (
		Array.isArray(value) &&
		value.every(
			(thread) =>
				thread &&
				typeof thread === "object" &&
				typeof thread.id === "string" &&
				thread.anchor &&
				typeof thread.anchor === "object",
		)
	);
}

export interface InlineEditorialComments {
	/** The toolbar's labels once it has sent this field's threads; until then nobody can comment. */
	labels: InlineEditorialLabels | null;
	/** Why the last Comment action couldn't start a thread. */
	notice: string | null;
	startComment: () => void;
	/** Moves the field's thread anchors to where the saved document has their text. */
	syncAnchors: (rev: string | undefined) => void;
}

export function useInlineEditorialComments({
	editor,
	bridge,
	root,
	collection,
	entryId,
	field,
	beforeDraft,
}: {
	editor: Editor | null;
	bridge: React.MutableRefObject<EditorialCommentsBridge>;
	root: HTMLElement | null;
	collection: string;
	entryId: string;
	field: string;
	/** Runs before a new thread's popover opens, so the thread's block is saved with its key. */
	beforeDraft: () => void;
}): InlineEditorialComments {
	const threadsRef = React.useRef<InlineThread[]>([]);
	// The anchor of the thread being written, until the toolbar reports it saved.
	const draftAnchorRef = React.useRef<EditorialAnchor | null>(null);
	const [labels, setLabels] = React.useState<InlineEditorialLabels | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);

	const matches = React.useCallback(
		(detail: EditorialEventDetail | null | undefined) =>
			detail?.collection === collection && detail.id === entryId && detail.field === field,
		[collection, entryId, field],
	);

	const dispatchOpen = React.useCallback(
		(request: { threadId: string } | { draft: { anchor: EditorialAnchor } }) => {
			document.dispatchEvent(
				new CustomEvent(EDITORIAL_EVENTS.open, {
					detail: { collection, id: entryId, field, ...request },
				}),
			);
		},
		[collection, entryId, field],
	);

	const openThread = React.useCallback(
		(threadId: string) => {
			if (!editor || editor.isDestroyed) return;
			setEditorialHighlights(editor.state, editor.view.dispatch, {
				activeThreadId: threadId,
				pending: null,
			});
			dispatchOpen({ threadId });
		},
		[dispatchOpen, editor],
	);

	const startComment = React.useCallback(() => {
		if (!editor || editor.isDestroyed || !labels) return;
		const { selection } = editor.state;
		if (selection.empty) {
			const caret = selection.from;
			const highlight = getEditorialHighlights(editor.state).find(
				(candidate) => caret > candidate.from && caret < candidate.to,
			);
			if (highlight) {
				setNotice(null);
				openThread(highlight.threadId);
				return;
			}
		}
		const result = anchorForSelection(
			editor.state,
			editor.view.dispatch,
			field,
			generateKey,
			editor.isEditable,
		);
		if (!result.ok) {
			setNotice(labels[REASON_LABELS[result.reason]]);
			return;
		}
		draftAnchorRef.current = result.anchor;
		setNotice(null);
		setEditorialHighlights(editor.state, editor.view.dispatch, {
			pending: result.range,
			activeThreadId: null,
		});
		beforeDraft();
		dispatchOpen({ draft: { anchor: result.anchor } });
	}, [beforeDraft, dispatchOpen, editor, field, labels, openThread]);

	const showThreads = React.useCallback(() => {
		if (!editor || editor.isDestroyed) return;
		const highlights: EditorialHighlight[] = [];
		for (const thread of threadsRef.current) {
			if (thread.status !== "open" || !isFieldAnchor(thread.anchor, field)) continue;
			const located = locateAnchor(editor.state.doc, thread.anchor);
			if (located) highlights.push({ threadId: thread.id, ...located });
		}
		setEditorialHighlights(editor.state, editor.view.dispatch, { highlights });
	}, [editor, field]);

	bridge.current = labels
		? {
				onActivate: openThread,
				onCommentShortcut: startComment,
			}
		: {};

	React.useEffect(() => {
		if (!editor) return;
		const announce = () => {
			if (!root) return;
			document.dispatchEvent(
				new CustomEvent(EDITORIAL_EVENTS.ready, {
					detail: { collection, id: entryId, field, element: root },
				}),
			);
		};
		const onThreads = (event: Event) => {
			const detail = eventDetail(event);
			if (!detail || !matches(detail) || !isThreads(detail.threads)) return;
			threadsRef.current = detail.threads;
			setLabels(isLabels(detail.labels) ? detail.labels : null);
			showThreads();
			const draftAnchor = draftAnchorRef.current;
			const saved = draftAnchor
				? detail.threads.find((thread) => sameAnchor(thread.anchor, draftAnchor))
				: undefined;
			if (saved && !editor.isDestroyed) {
				draftAnchorRef.current = null;
				setEditorialHighlights(editor.state, editor.view.dispatch, {
					pending: null,
					activeThreadId: saved.id,
				});
			}
		};
		const onClosed = (event: Event) => {
			if (!matches(eventDetail(event))) return;
			if (editor.isDestroyed) return;
			draftAnchorRef.current = null;
			setEditorialHighlights(editor.state, editor.view.dispatch, {
				pending: null,
				activeThreadId: null,
			});
		};
		document.addEventListener(EDITORIAL_EVENTS.threads, onThreads);
		document.addEventListener(EDITORIAL_EVENTS.closed, onClosed);
		document.addEventListener(EDITORIAL_EVENTS.start, announce);
		announce();
		return () => {
			document.removeEventListener(EDITORIAL_EVENTS.threads, onThreads);
			document.removeEventListener(EDITORIAL_EVENTS.closed, onClosed);
			document.removeEventListener(EDITORIAL_EVENTS.start, announce);
		};
	}, [collection, editor, entryId, field, matches, root, showThreads]);

	const syncAnchors = React.useCallback(
		(rev: string | undefined) => {
			if (!editor || editor.isDestroyed || !labels) return;
			const { doc } = editor.state;
			const located = new Map(
				getEditorialHighlights(editor.state).map((highlight) => [highlight.threadId, highlight]),
			);
			const updates: Array<{
				threadId: string;
				anchor: EditorialAnchor;
				anchorState: "attached" | "orphaned";
			}> = [];
			for (const thread of threadsRef.current) {
				const { anchor } = thread;
				if (thread.status !== "open" || !isFieldAnchor(anchor, field)) continue;
				const place = located.get(thread.id) ?? locateAnchor(doc, anchor);
				if (!place) {
					if (thread.anchorState !== "orphaned") {
						updates.push({ threadId: thread.id, anchor, anchorState: "orphaned" });
					}
					continue;
				}
				const current =
					anchor.type === "text" ? anchorForRange(doc, field, place.from, place.to) : anchor;
				if (!current) continue;
				if (thread.anchorState === "orphaned" || !sameAnchor(current, anchor)) {
					updates.push({ threadId: thread.id, anchor: current, anchorState: "attached" });
				}
			}
			if (updates.length === 0) return;
			const url = `/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}/threads/anchors`;
			void (async () => {
				try {
					for (let index = 0; index < updates.length; index += ANCHOR_BATCH_SIZE) {
						// oxlint-disable-next-line no-await-in-loop -- a conflict stops the batches after it
						const response = await fetch(url, {
							method: "PATCH",
							credentials: "same-origin",
							headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
							body: JSON.stringify({
								_rev: rev,
								anchors: updates.slice(index, index + ANCHOR_BATCH_SIZE),
							}),
						});
						if (!response.ok) throw new Error(`Anchor update failed: ${response.status}`);
					}
				} catch (error) {
					console.error("[emdash] Couldn't move comment anchors:", error);
				} finally {
					document.dispatchEvent(
						new CustomEvent(EDITORIAL_EVENTS.anchorsChanged, {
							detail: { collection, id: entryId },
						}),
					);
				}
			})();
		},
		[collection, editor, entryId, field, labels],
	);

	return { labels, notice, startComment, syncAnchors };
}

/** The admin editor's highlight rules, scoped to the inline editor and drawn in the site's text colour. */
export const INLINE_EDITORIAL_STYLES = `
	.emdash-inline-editor {
		--emdash-editorial-line: color-mix(in oklab, currentColor 55%, transparent);
	}
	.emdash-inline-editor .emdash-editorial-text {
		text-decoration-line: underline;
		text-decoration-style: dotted;
		text-decoration-thickness: 2px;
		text-decoration-color: var(--emdash-editorial-line);
		text-decoration-skip-ink: none;
		text-underline-offset: 6px;
		cursor: pointer;
	}
	.emdash-inline-editor .emdash-editorial-text:is(.emdash-editorial-hover, .emdash-editorial-active) {
		text-decoration-style: solid;
		text-decoration-color: currentColor;
		background-color: color-mix(in oklab, currentColor 8%, transparent);
		border-radius: 2px;
	}
	.emdash-inline-editor .emdash-editorial-text.emdash-editorial-active {
		background-color: color-mix(in oklab, currentColor 15%, transparent);
	}
	.emdash-inline-editor .emdash-editorial-block {
		position: relative;
	}
	.emdash-inline-editor .emdash-editorial-block::before {
		position: absolute;
		inset-block: 0;
		inset-inline-start: -10px;
		z-index: 1;
		inline-size: 3px;
		background-color: var(--emdash-editorial-line);
		content: "";
		pointer-events: none;
	}
	.emdash-inline-editor .emdash-editorial-block.emdash-editorial-active::before {
		background-color: currentColor;
	}
`;
