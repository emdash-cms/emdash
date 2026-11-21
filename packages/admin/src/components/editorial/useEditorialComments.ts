import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { sameAnchor, type EditorialAnchor } from "../../editorial-anchors.js";
import { ApiResponseError } from "../../lib/api/client.js";
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
import { generateKey } from "../../portable-text/keys.js";
import {
	anchorForRange,
	anchorForSelection,
	getEditorialHighlights,
	getEditorialPending,
	locateAnchor,
	setEditorialHighlights,
	type EditorialHighlight,
	type EditorialRange,
	type SelectionAnchorResult,
} from "../editor/EditorialCommentsExtension.js";

const POLL_INTERVAL_MS = 30_000;
/** The most anchors one request to the anchors route may carry. */
const ANCHOR_BATCH_SIZE = 100;

export interface EditorialDraft {
	anchor: EditorialAnchor;
	/** Where a text or block draft sits in its field's editor. */
	range: EditorialRange | null;
}

/** A thread's highlight in the editor of the Portable Text field it points at. */
export interface EditorialFieldHighlight extends EditorialHighlight {
	field: string;
}

type EditorAnchor = Extract<EditorialAnchor, { type: "text" | "block" }>;

export function editorialThreadsQueryKey(entry: EditorialEntry) {
	return ["editorial-threads", entry.collection, entry.id, { locale: entry.locale }] as const;
}

function entryKeyOf(entry: EditorialEntry | null): string | null {
	return entry ? JSON.stringify([entry.collection, entry.id, entry.locale ?? null]) : null;
}

/** Whether an anchor points into a Portable Text field's editor. */
export function isEditorAnchor(anchor: EditorialAnchor): anchor is EditorAnchor {
	return anchor.type === "text" || anchor.type === "block";
}

/** Identifies a stored anchor, whatever order its properties arrive in. */
function anchorSignature(anchor: EditorAnchor): string {
	return anchor.type === "block"
		? JSON.stringify(["block", anchor.field, anchor.blockKey])
		: JSON.stringify([
				"text",
				anchor.field,
				anchor.blockKey,
				anchor.start,
				anchor.end,
				anchor.quote,
				anchor.prefix,
				anchor.suffix,
			]);
}

interface MutationScope {
	target: EditorialEntry;
}

/**
 * Editorial threads for one entry, kept in step with the editors of its
 * Portable Text fields: text and block threads are highlighted where they
 * point, and anchors that moved are stored after each save.
 */
export function useEditorialComments({
	entry,
	editors,
	rev,
	isDirty,
	open,
	canEdit,
	initialThreadId,
}: {
	entry: EditorialEntry | null;
	/** The editor of each Portable Text field on the page, by field slug. */
	editors: ReadonlyMap<string, Editor>;
	rev: string | undefined;
	isDirty: boolean;
	open: boolean;
	/** Whether the user may edit the entry, which moving its threads' anchors needs. */
	canEdit: boolean;
	initialThreadId?: string;
}) {
	const { t, i18n } = useLingui();
	const [notice, setNotice] = React.useState<EditorialNotice | null>(null);
	const queryClient = useQueryClient();
	const [activeThreadId, setActiveThreadId] = React.useState<string | null>(
		initialThreadId ?? null,
	);
	const [draft, setDraft] = React.useState<EditorialDraft | null>(null);
	const [showResolved, setShowResolved] = React.useState(false);

	const entryKey = entryKeyOf(entry);
	const [stateEntryKey, setStateEntryKey] = React.useState(entryKey);
	const [stateThreadLink, setStateThreadLink] = React.useState(initialThreadId);
	/** A thread a link asked for that the margin hasn't brought into view yet. */
	const [linkedThreadId, setLinkedThreadId] = React.useState<string | null>(
		initialThreadId ?? null,
	);
	if (stateEntryKey !== entryKey) {
		setStateEntryKey(entryKey);
		setStateThreadLink(initialThreadId);
		setDraft(null);
		setActiveThreadId(initialThreadId ?? null);
		setLinkedThreadId(initialThreadId ?? null);
		setNotice(null);
	} else if (stateThreadLink !== initialThreadId) {
		setStateThreadLink(initialThreadId);
		if (initialThreadId) {
			setActiveThreadId(initialThreadId);
			setLinkedThreadId(initialThreadId);
		}
	}
	const entryKeyRef = React.useRef(entryKey);
	React.useLayoutEffect(() => {
		entryKeyRef.current = entryKey;
	}, [entryKey]);
	/** Whether the entry a mutation started for is still the one shown. */
	const isCurrent = (scope: MutationScope | undefined) =>
		scope !== undefined && entryKeyOf(scope.target) === entryKeyRef.current;

	React.useEffect(() => {
		if (!open) setActiveThreadId(null);
	}, [open]);

	const query = useQuery({
		queryKey: entry ? editorialThreadsQueryKey(entry) : ["editorial-threads", "none"],
		queryFn: () => fetchEditorialThreads(entry!),
		enabled: entry !== null,
		refetchInterval: open ? POLL_INTERVAL_MS : false,
		refetchOnWindowFocus: open ? "always" : false,
	});
	const threads = React.useMemo(() => query.data ?? [], [query.data]);
	const loadError: "load" | "refresh" | null = query.isLoadingError
		? "load"
		: query.isRefetchError
			? "refresh"
			: null;

	const invalidate = React.useCallback(
		(target: EditorialEntry) =>
			queryClient.invalidateQueries({ queryKey: editorialThreadsQueryKey(target) }),
		[queryClient],
	);

	const reportError =
		(title: string) => (error: unknown, _variables: unknown, scope: MutationScope | undefined) => {
			if (!isCurrent(scope)) return;
			setNotice({
				title,
				description: error instanceof Error ? error.message : undefined,
				variant: "error",
			});
		};

	const replaceThread = React.useCallback(
		(target: EditorialEntry, thread: EditorialThread) => {
			queryClient.setQueryData<EditorialThread[]>(editorialThreadsQueryKey(target), (current) =>
				current?.some((item) => item.id === thread.id)
					? current.map((item) => (item.id === thread.id ? thread : item))
					: [...(current ?? []), thread],
			);
		},
		[queryClient],
	);

	const dropThread = React.useCallback(
		(target: EditorialEntry, threadId: string) => {
			queryClient.setQueryData<EditorialThread[]>(editorialThreadsQueryKey(target), (current) =>
				current?.filter((item) => item.id !== threadId),
			);
		},
		[queryClient],
	);

	const scope = (): MutationScope => ({ target: entry! });

	/** A text draft's anchor as its highlight now sits, after any edits since it was started. */
	const currentDraftAnchor = (anchor: EditorialAnchor): EditorialAnchor => {
		if (anchor.type !== "text") return anchor;
		const editor = editors.get(anchor.field);
		const pending = editor && !editor.isDestroyed ? getEditorialPending(editor.state) : null;
		if (!editor || pending?.kind !== "text") return anchor;
		return anchorForRange(editor.state.doc, anchor.field, pending.from, pending.to) ?? anchor;
	};

	const createThread = useMutation({
		onMutate: scope,
		mutationFn: (input: { anchor: EditorialAnchor; body: string }) =>
			// A read-only editor may show an entry someone has saved since, so its anchor
			// goes without `_rev` and its quote and context place it.
			createEditorialThread(entry!, {
				...input,
				anchor: currentDraftAnchor(input.anchor),
				_rev: canEdit && !isDirty ? rev : undefined,
			}),
		onSuccess: (thread, _input, mutation) => {
			replaceThread(mutation.target, thread);
			if (!isCurrent(mutation)) return;
			setDraft(null);
			setActiveThreadId(thread.id);
		},
		onError: reportError(t`Comment not saved`),
	});

	const reply = useMutation({
		onMutate: scope,
		mutationFn: (input: { threadId: string; body: string }) =>
			replyToEditorialThread(entry!, input.threadId, input.body),
		onSuccess: (thread, _input, mutation) => replaceThread(mutation.target, thread),
		onError: reportError(t`Comment not saved`),
	});

	const setStatus = useMutation({
		onMutate: scope,
		mutationFn: (input: { threadId: string; status: EditorialThreadStatus }) =>
			setEditorialThreadStatus(entry!, input.threadId, input.status),
		onSuccess: (thread, _input, mutation) => {
			replaceThread(mutation.target, thread);
			if (isCurrent(mutation) && thread.status === "resolved") setActiveThreadId(null);
		},
		onError: reportError(t`Thread not updated`),
	});

	const deleteThread = useMutation({
		onMutate: scope,
		mutationFn: (threadId: string) => deleteEditorialThread(entry!, threadId),
		onSuccess: ({ threadId }, _input, mutation) => {
			dropThread(mutation.target, threadId);
			if (isCurrent(mutation)) setActiveThreadId(null);
		},
	});

	const editComment = useMutation({
		onMutate: scope,
		mutationFn: (input: { threadId: string; commentId: string; body: string }) =>
			editEditorialComment(entry!, input.threadId, input.commentId, input.body),
		onSuccess: (thread, _input, mutation) => replaceThread(mutation.target, thread),
		onError: reportError(t`Comment not saved`),
	});

	const deleteComment = useMutation({
		onMutate: scope,
		mutationFn: (input: { threadId: string; commentId: string }) =>
			deleteEditorialComment(entry!, input.threadId, input.commentId),
		onSuccess: (result, input, mutation) => {
			if (result.thread) replaceThread(mutation.target, result.thread);
			else dropThread(mutation.target, input.threadId);
		},
		onError: reportError(t`Comment not deleted`),
	});

	const [highlights, setHighlights] = React.useState<EditorialFieldHighlight[]>([]);
	const [attachedIds, setAttachedIds] = React.useState<ReadonlySet<string>>(() => new Set());
	/** The stored anchor each highlight was placed from, by editor and thread. */
	const placedRef = React.useRef(new WeakMap<Editor, Map<string, string>>());

	React.useEffect(() => {
		const nextHighlights: EditorialFieldHighlight[] = [];
		const attached = new Set<string>();
		for (const [field, editor] of editors) {
			const fieldThreads = threads.filter(
				({ anchor }) => isEditorAnchor(anchor) && anchor.field === field,
			);
			const placed = placedRef.current.get(editor);
			if (editor.isDestroyed || (fieldThreads.length === 0 && !placed?.size)) continue;
			const current = new Map(
				getEditorialHighlights(editor.state).map((highlight) => [highlight.threadId, highlight]),
			);
			const nextPlaced = new Map<string, string>();
			const next: EditorialHighlight[] = [];
			for (const thread of fieldThreads) {
				const { anchor } = thread;
				if (!isEditorAnchor(anchor)) continue;
				const signature = anchorSignature(anchor);
				// A highlight follows edits from where it was placed, so its stored anchor is
				// looked for again only once the anchor itself changes.
				const kept = current.get(thread.id);
				const range =
					kept && placed?.get(thread.id) === signature
						? kept
						: locateAnchor(editor.state.doc, anchor);
				if (!range) continue;
				attached.add(thread.id);
				if (thread.status !== "open" && thread.id !== activeThreadId) continue;
				const count = thread.comments.filter((comment) => !comment.deletedAt).length;
				next.push({
					threadId: thread.id,
					kind: range.kind,
					from: range.from,
					to: range.to,
					badge: i18n.number(count),
				});
				nextPlaced.set(thread.id, signature);
			}
			placedRef.current.set(editor, nextPlaced);
			setEditorialHighlights(editor.state, editor.view.dispatch, { highlights: next });
			for (const highlight of next) nextHighlights.push({ ...highlight, field });
		}
		setHighlights(nextHighlights);
		setAttachedIds(attached);
	}, [editors, threads, activeThreadId, i18n]);

	/** What each editor last showed, so a draft range it has mapped isn't put back where it started. */
	const shownRef = React.useRef(
		new WeakMap<Editor, { draft: EditorialDraft | null; activeThreadId: string | null }>(),
	);
	React.useEffect(() => {
		for (const [field, editor] of editors) {
			if (editor.isDestroyed) continue;
			const anchor = draft?.anchor;
			const pending =
				anchor && isEditorAnchor(anchor) && anchor.field === field ? draft.range : null;
			const shown = shownRef.current.get(editor);
			if (shown) {
				if (shown.draft === draft && shown.activeThreadId === activeThreadId) continue;
			} else if (!pending && activeThreadId === null) {
				continue;
			}
			const draftChanged = shown?.draft !== draft;
			shownRef.current.set(editor, { draft, activeThreadId });
			setEditorialHighlights(
				editor.state,
				editor.view.dispatch,
				draftChanged ? { activeThreadId, pending } : { activeThreadId },
			);
		}
	}, [editors, activeThreadId, draft]);

	const lastSyncedRef = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (!canEdit || !entry || isDirty || !rev || !query.data) return;
		const updates: EditorialAnchorUpdate[] = [];
		for (const [field, editor] of editors) {
			const inField = query.data.some(
				({ anchor }) => isEditorAnchor(anchor) && anchor.field === field,
			);
			if (!inField || editor.isDestroyed) continue;
			const located = new Map(
				getEditorialHighlights(editor.state).map((highlight) => [highlight.threadId, highlight]),
			);
			for (const thread of query.data) {
				if (thread.status !== "open") continue;
				const { anchor } = thread;
				if (!isEditorAnchor(anchor) || anchor.field !== field) continue;
				// A highlight dropped by an edit that was later undone is no longer mapped,
				// though its text is back, so look for the anchor again before orphaning it.
				const highlight = located.get(thread.id) ?? locateAnchor(editor.state.doc, anchor);
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
		}
		if (updates.length === 0) return;
		const signature = `${rev}:${JSON.stringify(updates)}`;
		if (lastSyncedRef.current === signature) return;
		lastSyncedRef.current = signature;
		const store = async () => {
			for (let index = 0; index < updates.length; index += ANCHOR_BATCH_SIZE) {
				// oxlint-disable-next-line no-await-in-loop -- a conflict stops the batches after it
				await updateEditorialAnchors(entry, {
					_rev: rev,
					anchors: updates.slice(index, index + ANCHOR_BATCH_SIZE),
				});
			}
		};
		store().then(
			() => {
				// The stored anchors now describe the highlights as they are, so the refetch keeps them.
				for (const update of updates) {
					if (update.anchorState !== "attached" || !isEditorAnchor(update.anchor)) continue;
					const editor = editors.get(update.anchor.field);
					const placed = editor && placedRef.current.get(editor);
					if (placed?.has(update.threadId)) {
						placed.set(update.threadId, anchorSignature(update.anchor));
					}
				}
				return invalidate(entry);
			},
			(error: unknown) => {
				void invalidate(entry);
				if (!(error instanceof ApiResponseError) || error.code !== "CONFLICT") {
					// Let the next change to the threads or highlights try again.
					if (lastSyncedRef.current === signature) lastSyncedRef.current = null;
					return;
				}
				// The entry changed since it loaded; once it reloads, its anchors are worked out again.
				void queryClient.invalidateQueries({
					queryKey: ["content", entry.collection, entry.id],
				});
			},
		);
	}, [canEdit, entry, editors, rev, isDirty, query.data, highlights, invalidate, queryClient]);

	/** The field whose editor last had focus or a new selection, for the margin's Comment button. */
	const lastFieldRef = React.useRef<string | null>(null);
	React.useEffect(() => {
		const cleanups: Array<() => void> = [];
		for (const [field, editor] of editors) {
			const remember = () => {
				lastFieldRef.current = field;
			};
			const rememberSelection = () => {
				if (!editor.state.selection.empty) remember();
			};
			editor.on("focus", remember);
			editor.on("selectionUpdate", rememberSelection);
			cleanups.push(() => {
				editor.off("focus", remember);
				editor.off("selectionUpdate", rememberSelection);
			});
		}
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}, [editors]);

	/**
	 * Starts a comment on the selection in a field's editor, by default the one
	 * last used, or on the whole entry without a selection.
	 */
	const startComment = React.useCallback(
		(field?: string) => {
			const target = field ?? lastFieldRef.current;
			const editor = target ? editors.get(target) : undefined;
			if (target && editor && !editor.isDestroyed && !editor.state.selection.empty) {
				const result = anchorForSelection(
					editor.state,
					editor.view.dispatch,
					target,
					generateKey,
					editor.isEditable,
				);
				if (result.ok) {
					setDraft({ anchor: result.anchor, range: result.range });
					setActiveThreadId(null);
					setNotice(null);
					return;
				}
				const { title, description } = SELECTION_NOTICES[result.reason];
				setNotice({
					title: t(title),
					description: description ? t(description) : undefined,
					variant: "default",
				});
				return;
			}
			setDraft({ anchor: { type: "entry" }, range: null });
			setActiveThreadId(null);
			setNotice(null);
		},
		[editors, t],
	);

	const openCount = threads.filter((thread) => thread.status === "open").length;

	return {
		entry,
		threads,
		isLoading: query.isLoading,
		/** Whether the threads failed to load, or the last refresh of them failed. */
		loadError,
		retry: query.refetch,
		isRetrying: query.isFetching,
		openCount,
		highlights,
		/** Text and block threads whose anchors are found in their field, highlighted or not. */
		attachedIds,
		editors,
		activeThreadId,
		setActiveThreadId,
		draft,
		setDraft,
		startComment,
		linkedThreadId,
		clearLinkedThread: React.useCallback(() => setLinkedThreadId(null), []),
		notice,
		dismissNotice: React.useCallback(() => setNotice(null), []),
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

const SELECTION_NOTICES: Record<
	Extract<SelectionAnchorResult, { ok: false }>["reason"],
	{ title: MessageDescriptor; description?: MessageDescriptor }
> = {
	"too-long": { title: msg`That selection is too long to comment on` },
	unkeyed: {
		title: msg`This block can’t take a comment yet`,
		description: msg`It can once someone who may edit the entry saves it.`,
	},
	empty: { title: msg`Select text within one paragraph to comment on it` },
	"multiple-blocks": { title: msg`Select text within one paragraph to comment on it` },
	unsupported: {
		title: msg`Text here can’t take a comment`,
		description: msg`Comment on the whole field instead.`,
	},
};

export type EditorialCommentsState = ReturnType<typeof useEditorialComments>;

/** A problem with the last comment action, shown at the head of the margin. */
export interface EditorialNotice {
	title: string;
	description?: string;
	variant: "default" | "error";
}
