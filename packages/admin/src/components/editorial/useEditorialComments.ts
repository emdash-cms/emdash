import { useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { sameAnchor, type EditorialAnchor } from "../../editorial-anchors.js";
import {
	createEditorialThread,
	deleteEditorialComment,
	deleteEditorialThread,
	editEditorialComment,
	fetchEditorialThreads,
	replyToEditorialThread,
	setEditorialThreadStatus,
	updateEditorialAnchors,
	type EditorialAnchorUpdate,
	type EditorialEntry,
	type EditorialThread,
	type EditorialThreadStatus,
} from "../../lib/api/editorial-threads.js";
import {
	anchorForRange,
	anchorForSelection,
	getEditorialHighlights,
	locateAnchor,
	setEditorialHighlights,
	type EditorialHighlight,
} from "../editor/EditorialCommentsExtension.js";

/** The field whose editor shows text and block threads in place. */
export const EDITORIAL_DOCUMENT_FIELD = "content";

const POLL_INTERVAL_MS = 30_000;

export interface EditorialDraft {
	anchor: EditorialAnchor;
	range: { from: number; to: number } | null;
}

function generateKey(): string {
	return Math.random().toString(36).substring(2, 11);
}

export function editorialThreadsQueryKey(entry: EditorialEntry) {
	return ["editorial-threads", entry.collection, entry.id, { locale: entry.locale }] as const;
}

/**
 * Editorial threads for one entry, kept in step with the open editor: open
 * text and block threads are highlighted in the document, and anchors that
 * moved are stored after each save.
 */
export function useEditorialComments({
	entry,
	editor,
	rev,
	isDirty,
	open,
	initialThreadId,
}: {
	entry: EditorialEntry | null;
	editor: Editor | null;
	rev: string | undefined;
	isDirty: boolean;
	open: boolean;
	initialThreadId?: string;
}) {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [activeThreadId, setActiveThreadId] = React.useState<string | null>(
		initialThreadId ?? null,
	);
	const [draft, setDraft] = React.useState<EditorialDraft | null>(null);
	const [showResolved, setShowResolved] = React.useState(false);

	const query = useQuery({
		queryKey: entry ? editorialThreadsQueryKey(entry) : ["editorial-threads", "none"],
		queryFn: () => fetchEditorialThreads(entry!),
		enabled: entry !== null,
		refetchInterval: open ? POLL_INTERVAL_MS : false,
		refetchOnWindowFocus: open ? "always" : false,
	});
	const threads = React.useMemo(() => query.data ?? [], [query.data]);

	const invalidate = React.useCallback(() => {
		if (!entry) return Promise.resolve();
		return queryClient.invalidateQueries({ queryKey: editorialThreadsQueryKey(entry) });
	}, [entry, queryClient]);

	const reportError = React.useCallback(
		(error: unknown) => {
			toastManager.add({
				title: t`Comment not saved`,
				description: error instanceof Error ? error.message : undefined,
				variant: "error",
			});
		},
		[t, toastManager],
	);

	const replaceThread = React.useCallback(
		(thread: EditorialThread) => {
			if (!entry) return;
			queryClient.setQueryData<EditorialThread[]>(editorialThreadsQueryKey(entry), (current) =>
				current?.some((item) => item.id === thread.id)
					? current.map((item) => (item.id === thread.id ? thread : item))
					: [...(current ?? []), thread],
			);
		},
		[entry, queryClient],
	);

	const dropThread = React.useCallback(
		(threadId: string) => {
			if (!entry) return;
			queryClient.setQueryData<EditorialThread[]>(editorialThreadsQueryKey(entry), (current) =>
				current?.filter((item) => item.id !== threadId),
			);
		},
		[entry, queryClient],
	);

	const createThread = useMutation({
		mutationFn: (input: { anchor: EditorialAnchor; body: string }) =>
			createEditorialThread(entry!, { ...input, _rev: isDirty ? undefined : rev }),
		onSuccess: (thread) => {
			replaceThread(thread);
			setDraft(null);
			setActiveThreadId(thread.id);
		},
		onError: reportError,
	});

	const reply = useMutation({
		mutationFn: (input: { threadId: string; body: string }) =>
			replyToEditorialThread(entry!, input.threadId, input.body),
		onSuccess: replaceThread,
		onError: reportError,
	});

	const setStatus = useMutation({
		mutationFn: (input: { threadId: string; status: EditorialThreadStatus }) =>
			setEditorialThreadStatus(entry!, input.threadId, input.status),
		onSuccess: (thread) => {
			replaceThread(thread);
			if (thread.status === "resolved") setActiveThreadId(null);
		},
		onError: reportError,
	});

	const deleteThread = useMutation({
		mutationFn: (threadId: string) => deleteEditorialThread(entry!, threadId),
		onSuccess: ({ threadId }) => {
			dropThread(threadId);
			setActiveThreadId(null);
		},
		onError: reportError,
	});

	const editComment = useMutation({
		mutationFn: (input: { threadId: string; commentId: string; body: string }) =>
			editEditorialComment(entry!, input.threadId, input.commentId, input.body),
		onSuccess: replaceThread,
		onError: reportError,
	});

	const deleteComment = useMutation({
		mutationFn: (input: { threadId: string; commentId: string }) =>
			deleteEditorialComment(entry!, input.threadId, input.commentId),
		onSuccess: (result, input) => {
			if (result.thread) replaceThread(result.thread);
			else dropThread(input.threadId);
		},
		onError: reportError,
	});

	const [highlights, setHighlights] = React.useState<EditorialHighlight[]>([]);

	React.useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const next: EditorialHighlight[] = [];
		for (const thread of threads) {
			if (thread.status !== "open" && thread.id !== activeThreadId) continue;
			const { anchor } = thread;
			if (anchor.type !== "text" && anchor.type !== "block") continue;
			if (anchor.field !== EDITORIAL_DOCUMENT_FIELD) continue;
			const range = locateAnchor(editor.state.doc, anchor);
			if (range) next.push({ threadId: thread.id, ...range });
		}
		setEditorialHighlights(editor.state, editor.view.dispatch, { highlights: next });
		setHighlights(next);
	}, [editor, threads, activeThreadId]);

	React.useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		setEditorialHighlights(editor.state, editor.view.dispatch, {
			activeThreadId,
			pending: draft?.range ?? null,
		});
	}, [editor, activeThreadId, draft]);

	const lastSyncedRef = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (!entry || !editor || editor.isDestroyed || isDirty || !rev || !query.data) return;
		const located = new Map(
			getEditorialHighlights(editor.state).map((highlight) => [highlight.threadId, highlight]),
		);
		const updates: EditorialAnchorUpdate[] = [];
		for (const thread of query.data) {
			if (thread.status !== "open") continue;
			const { anchor } = thread;
			if (anchor.type !== "text" && anchor.type !== "block") continue;
			if (anchor.field !== EDITORIAL_DOCUMENT_FIELD) continue;
			const highlight = located.get(thread.id);
			if (!highlight) {
				if (thread.anchorState === "attached") {
					updates.push({ threadId: thread.id, anchor, anchorState: "orphaned" });
				}
				continue;
			}
			const current =
				anchor.type === "text"
					? anchorForRange(editor.state.doc, anchor.field, highlight.from, highlight.to)
					: anchor;
			if (!current) continue;
			if (thread.anchorState === "orphaned" || !sameAnchor(current, anchor)) {
				updates.push({ threadId: thread.id, anchor: current, anchorState: "attached" });
			}
		}
		if (updates.length === 0) return;
		const signature = `${rev}:${JSON.stringify(updates)}`;
		if (lastSyncedRef.current === signature) return;
		lastSyncedRef.current = signature;
		updateEditorialAnchors(entry, { _rev: rev, anchors: updates }).then(
			() => invalidate(),
			// A conflict means the entry changed again; the next load resolves the anchors afresh.
			() => undefined,
		);
	}, [entry, editor, rev, isDirty, query.data, highlights, invalidate]);

	/** Starts a comment on the editor's selection, or on the whole entry without one. */
	const startComment = React.useCallback(() => {
		if (editor && !editor.isDestroyed && !editor.state.selection.empty) {
			const result = anchorForSelection(
				editor.state,
				editor.view.dispatch,
				EDITORIAL_DOCUMENT_FIELD,
				generateKey,
			);
			if (result.ok) {
				setDraft({ anchor: result.anchor, range: { from: result.from, to: result.to } });
				setActiveThreadId(null);
				return;
			}
			toastManager.add({
				title:
					result.reason === "too-long"
						? t`That selection is too long to comment on`
						: t`Select text within one paragraph to comment on it`,
			});
			return;
		}
		setDraft({ anchor: { type: "entry" }, range: null });
		setActiveThreadId(null);
	}, [editor, t, toastManager]);

	const openCount = threads.filter((thread) => thread.status === "open").length;

	return {
		threads,
		isLoading: query.isLoading,
		openCount,
		highlights,
		activeThreadId,
		setActiveThreadId,
		draft,
		setDraft,
		startComment,
		showResolved,
		setShowResolved,
		actions: {
			createThread,
			reply,
			setStatus,
			deleteThread,
			editComment,
			deleteComment,
		},
	};
}

export type EditorialCommentsState = ReturnType<typeof useEditorialComments>;
