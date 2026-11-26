import { Badge, Banner, Button, DropdownMenu, InputArea } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Check,
	ChatCircleText,
	DotsThree,
	ArrowCounterClockwise,
	PencilSimple,
	Trash,
} from "@phosphor-icons/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import type { EditorialAnchor } from "../../editorial-anchors.js";
import type {
	EditorialComment,
	EditorialEntry,
	EditorialPerson,
	EditorialThread,
} from "../../lib/api/editorial-threads.js";
import { cn, formatRelativeTime } from "../../lib/utils.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import {
	editorialCommentsKey,
	getEditorialHighlights,
	getEditorialPending,
	locateAnchor,
} from "../editor/EditorialCommentsExtension.js";
import {
	bodyToDraft,
	draftToBody,
	MentionText,
	updateDraftText,
	useMentionPicker,
	type MentionDraft,
} from "./mentions.js";
import { isEditorAnchor, type EditorialCommentsState } from "./useEditorialComments.js";

const CARD_GAP_PX = 8;
const WHITESPACE = /\s+/;
const EMPTY_DRAFT: MentionDraft = { text: "", mentions: [] };

export interface EditorialCommentsUser {
	id: string;
	name?: string | null;
	avatarUrl?: string | null;
}

/**
 * Scrolls a thread's text or block into view, and with `select` selects it and
 * focuses its editor. Returns whether the anchor was found.
 */
function goToAnchor(
	editors: ReadonlyMap<string, Editor>,
	thread: EditorialThread,
	select: boolean,
): boolean {
	const { anchor } = thread;
	if (!isEditorAnchor(anchor)) return false;
	const editor = editors.get(anchor.field);
	if (!editor || editor.isDestroyed) return false;
	// A resolved thread gets its highlight only once it is active, so look for its text directly.
	const range =
		getEditorialHighlights(editor.state).find((h) => h.threadId === thread.id) ??
		locateAnchor(editor.state.doc, anchor);
	if (!range) return false;
	if (select) {
		const { doc } = editor.state;
		const selection =
			range.kind === "block"
				? NodeSelection.create(doc, range.from)
				: TextSelection.create(doc, range.from, range.to);
		editor.view.dispatch(editor.state.tr.setSelection(selection));
		editor.view.focus();
	}
	const dom = editor.view.nodeDOM(range.from);
	const target =
		dom instanceof HTMLElement ? dom : editor.view.domAtPos(range.from).node.parentElement;
	target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	return true;
}

function initials(name: string | null | undefined): string {
	const trimmed = name?.trim();
	if (!trimmed) return "?";
	return trimmed
		.split(WHITESPACE)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
}

function Avatar({ person }: { person: Pick<EditorialPerson, "name" | "avatarUrl"> | null }) {
	if (person?.avatarUrl) {
		return (
			<img src={person.avatarUrl} alt="" className="size-6 shrink-0 rounded-full object-cover" />
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-6 shrink-0 items-center justify-center rounded-full bg-kumo-brand/10 text-[10px] font-medium"
		>
			{initials(person?.name)}
		</span>
	);
}

function useAnchorLabel() {
	const { t } = useLingui();
	return (anchor: EditorialAnchor, fieldLabels: Record<string, string>): string | null => {
		switch (anchor.type) {
			case "entry":
				return t`Whole entry`;
			case "field":
			case "block":
				return fieldLabels[anchor.field] ?? anchor.field;
			case "text":
				return null;
		}
	};
}

/**
 * The field each field thread, or the draft, points at, keyed by thread id or
 * `draft`, for those fields shown on the page.
 */
function useFieldElements(
	fieldsRef: React.RefObject<HTMLElement | null>,
	threads: EditorialThread[],
	draftAnchor: EditorialAnchor | null,
	enabled: boolean,
): Map<string, HTMLElement> {
	const [elements, setElements] = React.useState(() => new Map<string, HTMLElement>());
	const anchored = [
		...threads.map((thread) => ({ id: thread.id, anchor: thread.anchor })),
		...(draftAnchor ? [{ id: "draft", anchor: draftAnchor }] : []),
	];
	const signature = anchored
		.map(({ id, anchor }) => (anchor.type === "field" ? `${id}:${anchor.field}` : ""))
		.join();
	React.useLayoutEffect(() => {
		const root = fieldsRef.current;
		const next = new Map<string, HTMLElement>();
		if (root && enabled) {
			for (const { id, anchor } of anchored) {
				if (anchor.type !== "field") continue;
				const element = root.querySelector<HTMLElement>(
					`[data-editorial-field="${CSS.escape(anchor.field)}"]`,
				);
				if (element) next.set(id, element);
			}
		}
		setElements((current) =>
			current.size === next.size && [...next].every(([id, element]) => current.get(id) === element)
				? current
				: next,
		);
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the field threads change
	}, [fieldsRef, signature, enabled]);
	return elements;
}

/** Vertical positions for cards beside their anchors, pushed down so none overlap. */
function useCardLayout(
	editors: ReadonlyMap<string, Editor>,
	gutterRef: React.RefObject<HTMLDivElement | null>,
	fieldsRef: React.RefObject<HTMLElement | null>,
	positionedIds: string[],
	fieldThreads: Map<string, HTMLElement>,
	/** The fields whose editors hold the highlights and draft being placed. */
	editorFields: string[],
	draftField: string | null,
	enabled: boolean,
) {
	const cardRefs = React.useRef(new Map<string, HTMLElement>());
	const [tops, setTops] = React.useState<Record<string, number>>({});
	const [version, setVersion] = React.useState(0);
	const frameRef = React.useRef(0);
	const bump = React.useCallback(() => {
		cancelAnimationFrame(frameRef.current);
		frameRef.current = requestAnimationFrame(() => setVersion((value) => value + 1));
	}, []);
	// A card grows with a reply being written or a comment being edited, pushing the cards below it.
	const [cardObserver] = React.useState(() => new ResizeObserver(bump));
	React.useEffect(() => {
		for (const element of cardRefs.current.values()) cardObserver.observe(element);
		return () => {
			cancelAnimationFrame(frameRef.current);
			cardObserver.disconnect();
		};
	}, [cardObserver]);

	React.useEffect(() => {
		if (!enabled) return;
		for (const editor of editors.values()) editor.on("transaction", bump);
		// Fields above an editor, such as an image that finishes loading, move the text without resizing it.
		const observer = new ResizeObserver(bump);
		const fields = fieldsRef.current;
		const page = fields?.closest(".emdash-editor-page") ?? fields;
		if (page) observer.observe(page);
		if (gutterRef.current) observer.observe(gutterRef.current);
		return () => {
			for (const editor of editors.values()) editor.off("transaction", bump);
			observer.disconnect();
		};
	}, [editors, enabled, gutterRef, fieldsRef, bump]);

	React.useLayoutEffect(() => {
		const gutter = gutterRef.current;
		if (!gutter || !enabled) return;
		const origin = gutter.getBoundingClientRect().top;
		const ranges = new Map<string, { editor: Editor; from: number }>();
		for (const field of editorFields) {
			const editor = editors.get(field);
			if (!editor || editor.isDestroyed) continue;
			for (const highlight of getEditorialHighlights(editor.state)) {
				ranges.set(highlight.threadId, { editor, from: highlight.from });
			}
			const pending = editorialCommentsKey.getState(editor.state)?.pending;
			if (pending && field === draftField) ranges.set("draft", { editor, from: pending.from });
		}
		const wanted = positionedIds
			.map((id) => {
				const field = fieldThreads.get(id);
				if (field) return { id, top: field.getBoundingClientRect().top - origin };
				const range = ranges.get(id);
				if (!range) return null;
				return { id, top: range.editor.view.coordsAtPos(range.from).top - origin };
			})
			.filter((item): item is { id: string; top: number } => item !== null)
			.toSorted((a, b) => a.top - b.top);

		const next: Record<string, number> = {};
		let floor = 0;
		for (const item of wanted) {
			const top = Math.max(item.top, floor);
			next[item.id] = top;
			floor = top + (cardRefs.current.get(item.id)?.offsetHeight ?? 0) + CARD_GAP_PX;
		}
		setTops((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
	}, [editors, gutterRef, positionedIds, fieldThreads, editorFields, draftField, enabled, version]);

	// One callback per card, so re-rendering doesn't detach and observe it again.
	const registrations = React.useRef(new Map<string, (element: HTMLElement | null) => void>());
	const register = React.useCallback(
		(id: string) => {
			let callback = registrations.current.get(id);
			if (!callback) {
				callback = (element) => {
					const previous = cardRefs.current.get(id);
					if (previous) cardObserver.unobserve(previous);
					if (element) {
						cardRefs.current.set(id, element);
						cardObserver.observe(element);
					} else {
						cardRefs.current.delete(id);
						registrations.current.delete(id);
					}
				};
				registrations.current.set(id, callback);
			}
			return callback;
		},
		[cardObserver],
	);

	return { tops, register };
}

/**
 * Replies and comment edits not yet sent, by `reply:` thread or `edit:` comment
 * ID. They outlive a card, which remounts when it moves between the list and
 * its anchor.
 */
const UnsentTextContext = React.createContext<UnsentText | null>(null);

class UnsentText {
	private values = new Map<string, MentionDraft>();
	private listeners = new Map<string, Set<() => void>>();

	get(key: string) {
		return this.values.get(key);
	}

	set(key: string, value: MentionDraft | undefined) {
		if (value === undefined) this.values.delete(key);
		else this.values.set(key, value);
		for (const listener of this.listeners.get(key) ?? []) listener();
	}

	subscribe(key: string, listener: () => void) {
		let listeners = this.listeners.get(key);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(key, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(key);
		};
	}
}

/**
 * Text held for `key` across remounts; `undefined` once it is cleared or sent.
 * A request that finishes after its card has moved clears the card shown now.
 */
function useUnsentText(
	key: string,
): [MentionDraft | undefined, (value: MentionDraft | undefined) => void] {
	const store = React.useContext(UnsentTextContext);
	if (!store) throw new Error("useUnsentText needs an UnsentTextContext provider");
	const subscribe = React.useCallback(
		(listener: () => void) => store.subscribe(key, listener),
		[store, key],
	);
	const value = React.useSyncExternalStore(subscribe, () => store.get(key));
	const update = React.useCallback(
		(next: MentionDraft | undefined) => store.set(key, next),
		[store, key],
	);
	return [value, update];
}

/**
 * Comment threads in the margin beside the entry. Text, block and field threads
 * sit next to what they point at; entry and detached threads, and threads on
 * fields outside the page, head the column. Below the large breakpoint the
 * cards stack in a list instead.
 */
export function MarginComments({
	comments,
	currentUser,
	fieldLabels,
	fieldsRef,
	positioned,
	canComment,
}: {
	comments: EditorialCommentsState;
	currentUser: EditorialCommentsUser | undefined;
	fieldLabels: Record<string, string>;
	/** Holds an element marked `data-editorial-field` for each field on the page. */
	fieldsRef: React.RefObject<HTMLElement | null>;
	positioned: boolean;
	canComment: boolean;
}) {
	const { t } = useLingui();
	const marginRef = React.useRef<HTMLElement>(null);
	const gutterRef = React.useRef<HTMLDivElement>(null);
	const [unsent] = React.useState(() => new UnsentText());
	const { threads, highlights, attachedIds, editors, activeThreadId, draft, showResolved } =
		comments;

	const { linkedThreadId, clearLinkedThread, isLoading } = comments;
	React.useEffect(() => {
		if (!linkedThreadId || isLoading) return;
		const thread = threads.find((candidate) => candidate.id === linkedThreadId);
		const { anchor } = thread ?? {};
		// Wait for the editor of a field on the page, so the link lands on its text.
		if (anchor && isEditorAnchor(anchor) && Object.hasOwn(fieldLabels, anchor.field)) {
			if (!editors.has(anchor.field)) return;
		}
		if (thread && !goToAnchor(editors, thread, false)) {
			const card = marginRef.current?.querySelector(
				`[data-editorial-thread-card="${CSS.escape(thread.id)}"]`,
			);
			// Until its card is shown, keep the link to try again on the next render.
			if (!card) return;
			card.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
		clearLinkedThread();
	});

	const placed = React.useMemo(
		() => new Set(highlights.map((highlight) => highlight.threadId)),
		[highlights],
	);
	// An edit drops a highlight whose text it deletes before the threads are placed again, so
	// read what the editors hold now. Each transaction re-renders the margin.
	const highlighted = new Set<string>();
	for (const field of new Set(highlights.map((highlight) => highlight.field))) {
		const editor = editors.get(field);
		if (!editor || editor.isDestroyed) continue;
		for (const highlight of getEditorialHighlights(editor.state)) {
			highlighted.add(highlight.threadId);
		}
	}
	const isDetached = (thread: EditorialThread) => {
		const { anchor } = thread;
		if (!isEditorAnchor(anchor)) return false;
		if (!Object.hasOwn(fieldLabels, anchor.field)) return true;
		// Until its field's editor is ready, a thread is as the server last found it.
		if (!editors.has(anchor.field)) return thread.anchorState === "orphaned";
		if (placed.has(thread.id) && !highlighted.has(thread.id)) return true;
		return !attachedIds.has(thread.id);
	};
	const visible = threads.filter(
		(thread) => thread.status === "open" || showResolved || thread.id === activeThreadId,
	);
	const fieldThreads = useFieldElements(fieldsRef, visible, draft?.anchor ?? null, positioned);
	const inPlace = positioned
		? visible.filter((thread) => highlighted.has(thread.id) || fieldThreads.has(thread.id))
		: [];
	const listed = visible.filter((thread) => !inPlace.includes(thread));
	const draftAnchor = draft?.anchor;
	const draftField = draftAnchor && isEditorAnchor(draftAnchor) ? draftAnchor.field : null;
	const draftEditor = draftField ? editors.get(draftField) : undefined;
	const draftPending =
		draft?.range && draftEditor && !draftEditor.isDestroyed
			? getEditorialPending(draftEditor.state)
			: null;
	// The editor takes a draft's range after the first render, and drops it once its text is deleted.
	const [shownDraft, setShownDraft] = React.useState<typeof draft>(null);
	React.useEffect(() => {
		if (draftPending && draft) setShownDraft(draft);
	}, [draftPending, draft]);
	const draftLost = draft?.range != null && shownDraft === draft && !draftPending;
	const draftInPlace =
		positioned && !draftLost && (draft?.range != null || fieldThreads.has("draft"));
	const [draftBody, setDraftBody] = React.useState({ draft, body: EMPTY_DRAFT });
	const draftText = draftBody.draft === draft ? draftBody.body : EMPTY_DRAFT;
	const positionedIds = React.useMemo(
		() => [...inPlace.map((thread) => thread.id), ...(draftInPlace ? ["draft"] : [])],
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the set of ids changes
		[inPlace.map((thread) => thread.id).join(), draftInPlace],
	);
	const editorFieldsKey = [
		...new Set([
			...highlights.map((highlight) => highlight.field),
			...(draftField ? [draftField] : []),
		]),
	]
		.toSorted()
		.join("\u0000");
	const editorFields = React.useMemo(
		() => (editorFieldsKey ? editorFieldsKey.split("\u0000") : []),
		[editorFieldsKey],
	);
	const { tops, register } = useCardLayout(
		editors,
		gutterRef,
		fieldsRef,
		positionedIds,
		fieldThreads,
		editorFields,
		draftField,
		positioned,
	);
	const resolvedCount = threads.filter((thread) => thread.status === "resolved").length;

	const draftCard = draft && (
		<DraftCard
			key="draft"
			focusKey={
				!draftLost && (!draftInPlace || "draft" in tops) ? JSON.stringify(draft.anchor) : null
			}
			detached={draftLost}
			body={draftText}
			onBodyChange={(value) => setDraftBody({ draft, body: value })}
			quote={draft.anchor.type === "text" ? draft.anchor.quote : null}
			entry={comments.entry}
			currentUser={currentUser}
			pending={comments.actions.createThread.isPending}
			onCancel={() => comments.setDraft(null)}
			onSubmit={(body) => comments.actions.createThread.mutate({ anchor: draft.anchor, body })}
		/>
	);

	return (
		<UnsentTextContext.Provider value={unsent}>
			<aside ref={marginRef} aria-label={t`Comments`} className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-2">
					<h2 className="text-sm font-semibold">{t`Comments`}</h2>
					<div className="flex items-center gap-1">
						{resolvedCount > 0 && (
							<Button
								variant="ghost"
								size="sm"
								type="button"
								aria-pressed={showResolved}
								onClick={() => comments.setShowResolved(!showResolved)}
							>
								{showResolved ? t`Hide resolved` : t`Show resolved`}
							</Button>
						)}
						{canComment && (
							<Button
								variant="secondary"
								size="sm"
								type="button"
								icon={<ChatCircleText aria-hidden="true" />}
								onClick={() => comments.startComment()}
							>
								{t`Comment`}
							</Button>
						)}
					</div>
				</div>

				{comments.loadError && (
					<Banner
						size="sm"
						variant="error"
						role="alert"
						title={
							comments.loadError === "load"
								? t`Comments couldn’t be loaded`
								: t`Comments couldn’t be refreshed`
						}
						description={
							comments.loadError === "refresh"
								? t`These may not be the latest comments.`
								: undefined
						}
						action={
							<Button
								variant="ghost"
								size="xs"
								type="button"
								loading={comments.isRetrying}
								onClick={() => void comments.retry()}
							>
								{t`Try again`}
							</Button>
						}
					/>
				)}
				{comments.notice && (
					<Banner
						size="sm"
						variant={comments.notice.variant}
						role={comments.notice.variant === "error" ? "alert" : "status"}
						title={comments.notice.title}
						description={comments.notice.description}
						action={
							<Button variant="ghost" size="xs" type="button" onClick={comments.dismissNotice}>
								{t`Dismiss`}
							</Button>
						}
					/>
				)}
				{!draftInPlace && draftCard}
				{listed.map((thread) => (
					<ThreadCard
						key={thread.id}
						thread={thread}
						comments={comments}
						inPlace={false}
						fieldLabels={fieldLabels}
						detached={isDetached(thread)}
						canComment={canComment}
					/>
				))}
				{threads.length === 0 && !draft && !comments.isLoading && comments.loadError !== "load" && (
					<p className="text-sm text-kumo-subtle">
						{t`Select text and press Comment, or comment on the whole entry.`}
					</p>
				)}

				{positioned && (
					<div ref={gutterRef} className="relative flex-1">
						{inPlace.map((thread) => (
							<div
								key={thread.id}
								ref={register(thread.id)}
								className="absolute inset-x-0"
								style={{
									top: tops[thread.id] ?? 0,
									visibility: thread.id in tops ? undefined : "hidden",
								}}
							>
								<ThreadCard
									thread={thread}
									comments={comments}
									inPlace
									fieldLabels={fieldLabels}
									detached={false}
									canComment={canComment}
								/>
							</div>
						))}
						{draftInPlace && (
							<div
								ref={register("draft")}
								className="absolute inset-x-0"
								style={{ top: tops.draft ?? 0, visibility: "draft" in tops ? undefined : "hidden" }}
							>
								{draftCard}
							</div>
						)}
					</div>
				)}
			</aside>
		</UnsentTextContext.Provider>
	);
}

function DraftCard({
	focusKey,
	quote,
	detached,
	body,
	onBodyChange,
	entry,
	currentUser,
	pending,
	onCancel,
	onSubmit,
}: {
	/** Null while the card is hidden for measuring or has lost its text. Each new key moves focus to the composer. */
	focusKey: string | null;
	quote: string | null;
	detached: boolean;
	/** Held by the margin, so the text survives the card moving between the list and its anchor. */
	body: MentionDraft;
	onBodyChange: (body: MentionDraft) => void;
	entry: EditorialEntry | null;
	currentUser: EditorialCommentsUser | undefined;
	pending: boolean;
	onCancel: () => void;
	onSubmit: (body: string) => void;
}) {
	const { t } = useLingui();
	const cardRef = React.useRef<HTMLDivElement>(null);
	// A hidden element can't take focus, so `autoFocus` would miss a card that mounts before it's placed.
	React.useEffect(() => {
		if (focusKey !== null) cardRef.current?.querySelector<HTMLElement>("textarea")?.focus();
	}, [focusKey]);
	return (
		<div ref={cardRef} className="rounded-xl border border-kumo-brand bg-kumo-base p-3 shadow-md">
			<div className="mb-2 flex items-center gap-2">
				<Avatar
					person={
						currentUser
							? { name: currentUser.name ?? null, avatarUrl: currentUser.avatarUrl ?? null }
							: null
					}
				/>
				<span className="truncate text-sm font-medium">{currentUser?.name ?? t`You`}</span>
			</div>
			{quote && <Quote text={quote} detached={detached} />}
			<CommentComposer
				entry={entry}
				value={body}
				onChange={onBodyChange}
				label={t`Comment`}
				placeholder={t`Add a comment. Type @ to mention someone.`}
				submitLabel={t`Comment`}
				pending={pending}
				onCancel={onCancel}
				onSubmit={() => onSubmit(draftToBody(body))}
			/>
		</div>
	);
}

function Quote({ text, detached }: { text: string; detached?: boolean }) {
	return (
		<blockquote
			className={cn(
				"mb-2 line-clamp-2 border-s-2 ps-2 text-xs text-kumo-subtle",
				detached ? "border-kumo-line line-through" : "border-kumo-brand",
			)}
		>
			{text}
		</blockquote>
	);
}

function CommentComposer({
	entry,
	value,
	onChange,
	label,
	placeholder,
	submitLabel,
	pending,
	autoFocus,
	compact,
	onCancel,
	onSubmit,
}: {
	entry: EditorialEntry | null;
	value: MentionDraft;
	onChange: (value: MentionDraft) => void;
	label: string;
	placeholder: string;
	submitLabel: string;
	pending: boolean;
	autoFocus?: boolean;
	/** One line that grows with the text, with its buttons shown once there is something to send. */
	compact?: boolean;
	onCancel?: () => void;
	onSubmit: () => void;
}) {
	const { t } = useLingui();
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);
	const picker = useMentionPicker({ entry, draft: value, onDraftChange: onChange, textareaRef });
	const empty = value.text.trim().length === 0;
	return (
		<div className="flex flex-col gap-2">
			<InputArea
				ref={textareaRef}
				aria-label={label}
				placeholder={placeholder}
				value={value.text}
				rows={compact ? 1 : 2}
				autoFocus={autoFocus}
				className="max-h-60 resize-none field-sizing-content"
				{...picker.textareaProps}
				onChange={(event) => {
					onChange(updateDraftText(value, event.target.value, event.target.selectionStart));
					picker.syncCaret(event);
				}}
				onKeyDown={(event) => {
					// Keys that confirm or move through an IME candidate belong to the input method.
					if (event.nativeEvent.isComposing || event.keyCode === 229) return;
					if (picker.handleKeyDown(event)) return;
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !empty && !pending) {
						event.preventDefault();
						onSubmit();
					}
					if (event.key === "Escape" && onCancel) {
						event.preventDefault();
						onCancel();
					}
				}}
			/>
			{picker.listbox}
			{(!compact || !empty) && (
				<div className="flex justify-end gap-2">
					{onCancel && (
						<Button variant="ghost" size="sm" type="button" onClick={onCancel}>
							{t`Cancel`}
						</Button>
					)}
					<Button
						variant="primary"
						size="sm"
						type="button"
						disabled={empty || pending}
						loading={pending}
						onClick={onSubmit}
					>
						{submitLabel}
					</Button>
				</div>
			)}
		</div>
	);
}

function ThreadCard({
	thread,
	comments,
	inPlace,
	fieldLabels,
	detached,
	canComment,
}: {
	thread: EditorialThread;
	comments: EditorialCommentsState;
	inPlace: boolean;
	fieldLabels: Record<string, string>;
	detached: boolean;
	canComment: boolean;
}) {
	const { t, i18n } = useLingui();
	const anchorLabel = useAnchorLabel();
	const active = comments.activeThreadId === thread.id;
	const [unsentReply, setUnsentReply] = useUnsentText(`reply:${thread.id}`);
	const reply = unsentReply ?? EMPTY_DRAFT;
	const setReply = (value: MentionDraft) => setUnsentReply(value.text ? value : undefined);
	const [confirmingDelete, setConfirmingDelete] = React.useState(false);
	/** The last live comment, whose deletion also deletes the thread, while that is confirmed. */
	const [confirmingLastComment, setConfirmingLastComment] = React.useState<string | null>(null);
	const liveComments = thread.comments.filter((comment) => !comment.deletedAt).length;
	const resolved = thread.status === "resolved";
	const { actions } = comments;
	const heading = inPlace
		? null
		: thread.anchor.type === "text"
			? (fieldLabels[thread.anchor.field] ?? thread.anchor.field)
			: anchorLabel(thread.anchor, fieldLabels);

	const activate = () => {
		if (active) return;
		comments.setActiveThreadId(thread.id);
		goToAnchor(comments.editors, thread, false);
	};

	const visibleComments = active ? thread.comments : thread.comments.slice(0, 1);
	const hiddenReplies = thread.comments.length - visibleComments.length;

	return (
		<>
			<article
				aria-label={t`Comment thread`}
				data-editorial-thread-card={thread.id}
				tabIndex={active ? -1 : 0}
				onClick={activate}
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget) return;
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						activate();
					}
					if (event.key === "Escape") comments.setActiveThreadId(null);
				}}
				className={cn(
					"group/thread rounded-xl border bg-kumo-base p-3 text-sm transition-[border-color,box-shadow]",
					active
						? "border-kumo-brand shadow-md"
						: "cursor-pointer border-kumo-line hover:shadow-sm",
					resolved && !active && "opacity-75",
				)}
			>
				{(heading || detached || resolved) && (
					<div className="mb-2 flex min-w-0 items-center gap-1.5">
						{heading && <span className="truncate text-xs text-kumo-subtle">{heading}</span>}
						{detached && <Badge variant="secondary">{t`Detached`}</Badge>}
						{resolved && <Badge variant="secondary">{t`Resolved`}</Badge>}
					</div>
				)}

				{thread.anchor.type === "text" && (detached || !active) && (
					<Quote text={thread.anchor.quote} detached={detached} />
				)}

				<ol className="flex flex-col gap-3">
					{visibleComments.map((comment, index) => (
						<CommentItem
							key={comment.id}
							comment={comment}
							revealed={active}
							threadActions={
								index === 0 && thread.can.resolve ? (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										type="button"
										aria-label={resolved ? t`Reopen` : t`Resolve`}
										title={resolved ? t`Reopen` : t`Resolve`}
										disabled={actions.setStatus.isPending}
										onClick={() =>
											actions.setStatus.mutate({
												threadId: thread.id,
												status: resolved ? "open" : "resolved",
											})
										}
									>
										{resolved ? (
											<ArrowCounterClockwise className="size-4" aria-hidden="true" />
										) : (
											<Check className="size-4" aria-hidden="true" />
										)}
									</Button>
								) : null
							}
							onDeleteThread={
								index === 0 && thread.can.delete ? () => setConfirmingDelete(true) : undefined
							}
							entry={comments.entry}
							people={thread.mentions}
							locale={i18n.locale}
							editPending={
								actions.editComment.isPending &&
								actions.editComment.variables?.commentId === comment.id
							}
							onEdit={(body, onSaved) =>
								actions.editComment.mutate(
									{ threadId: thread.id, commentId: comment.id, body },
									{ onSuccess: onSaved },
								)
							}
							onDelete={() => {
								if (liveComments === 1) setConfirmingLastComment(comment.id);
								else actions.deleteComment.mutate({ threadId: thread.id, commentId: comment.id });
							}}
						/>
					))}
				</ol>
				{hiddenReplies > 0 && (
					<p className="mt-2 ps-8 text-xs font-medium text-kumo-link">
						{plural(hiddenReplies, { one: "# reply", other: "# replies" })}
					</p>
				)}

				{active && isEditorAnchor(thread.anchor) && !detached && (
					<Button
						variant="ghost"
						size="sm"
						type="button"
						className="mt-2"
						onClick={(event) => {
							event.stopPropagation();
							goToAnchor(comments.editors, thread, true);
						}}
					>
						{thread.anchor.type === "block" ? t`Go to block` : t`Go to text`}
					</Button>
				)}

				{active && canComment && (
					<div className="mt-3" onClick={(event) => event.stopPropagation()}>
						<CommentComposer
							entry={comments.entry}
							value={reply}
							onChange={setReply}
							compact
							label={t`Reply`}
							placeholder={resolved ? t`Reply to reopen` : t`Reply`}
							submitLabel={t`Reply`}
							pending={actions.reply.isPending}
							onSubmit={() =>
								actions.reply.mutate(
									{ threadId: thread.id, body: draftToBody(reply) },
									{ onSuccess: () => setReply(EMPTY_DRAFT) },
								)
							}
						/>
					</div>
				)}
			</article>
			{/* Outside the card, so clicks and Escape in the dialog don't reach the card's handlers. */}
			<ConfirmDialog
				open={confirmingDelete}
				onClose={() => {
					setConfirmingDelete(false);
					actions.deleteThread.reset();
				}}
				role="alertdialog"
				title={t`Delete thread`}
				description={t`This deletes the thread and every reply in it. This action cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={actions.deleteThread.isPending}
				error={actions.deleteThread.error}
				onConfirm={() =>
					actions.deleteThread.mutate(thread.id, { onSuccess: () => setConfirmingDelete(false) })
				}
			/>
			<ConfirmDialog
				open={confirmingLastComment !== null}
				onClose={() => {
					setConfirmingLastComment(null);
					actions.deleteComment.reset();
				}}
				role="alertdialog"
				title={t`Delete comment`}
				description={t`This is the thread's only comment, so deleting it deletes the thread too. This action cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={actions.deleteComment.isPending}
				error={actions.deleteComment.error}
				onConfirm={() => {
					if (!confirmingLastComment) return;
					actions.deleteComment.mutate(
						{ threadId: thread.id, commentId: confirmingLastComment },
						{ onSuccess: () => setConfirmingLastComment(null) },
					);
				}}
			/>
		</>
	);
}

function CommentItem({
	comment,
	revealed,
	threadActions,
	onDeleteThread,
	entry,
	people,
	locale,
	editPending,
	onEdit,
	onDelete,
}: {
	comment: EditorialComment;
	/** Shows the actions without hovering, as on the open thread. */
	revealed: boolean;
	/** Thread controls that sit beside the first comment's menu. */
	threadActions?: React.ReactNode;
	onDeleteThread?: () => void;
	entry: EditorialEntry | null;
	people: EditorialPerson[];
	locale: string;
	editPending: boolean;
	/** Saves an edit, calling `onSaved` once it is stored. */
	onEdit: (body: string, onSaved: () => void) => void;
	onDelete: () => void;
}) {
	const { t } = useLingui();
	const [edit, setEdit] = useUnsentText(`edit:${comment.id}`);
	const editing = edit !== undefined;
	const body = edit ?? EMPTY_DRAFT;
	const setBody = (value: MentionDraft) => setEdit(value);
	const setEditing = (value: boolean) =>
		setEdit(
			value
				? bodyToDraft(comment.body, people, { unknown: t`Unknown user`, unnamed: t`Unnamed user` })
				: undefined,
		);
	const deleted = comment.deletedAt !== null;
	const name = comment.author?.name ?? (comment.author ? t`Unnamed user` : t`Deleted user`);

	const hasMenu = comment.can.edit || comment.can.delete || onDeleteThread !== undefined;

	return (
		<li className="flex flex-col gap-0.5">
			<div className="flex min-h-7 items-center gap-2">
				<Avatar person={comment.author} />
				<div className="flex min-w-0 flex-1 items-baseline gap-1.5">
					<span className="truncate font-medium">{name}</span>
					<time dateTime={comment.createdAt} className="shrink-0 text-xs text-kumo-subtle">
						<bdi>{formatRelativeTime(comment.createdAt, locale)}</bdi>
					</time>
				</div>
				{(threadActions || hasMenu) && !editing && (
					<div
						className={cn(
							"-me-1.5 -my-1 flex shrink-0 items-center",
							!revealed &&
								"opacity-0 transition-opacity group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 pointer-coarse:opacity-100",
						)}
						onClick={(event) => event.stopPropagation()}
					>
						{threadActions}
						{hasMenu && (
							<DropdownMenu>
								<DropdownMenu.Trigger
									render={
										<Button
											variant="ghost"
											size="sm"
											shape="square"
											type="button"
											aria-label={t`Comment actions`}
										>
											<DotsThree className="size-4" aria-hidden="true" />
										</Button>
									}
								/>
								<DropdownMenu.Content align="end">
									{comment.can.edit && (
										<DropdownMenu.Item
											icon={<PencilSimple className="size-4" aria-hidden="true" />}
											onClick={() => setEditing(true)}
										>
											{t`Edit`}
										</DropdownMenu.Item>
									)}
									{comment.can.delete && (
										<DropdownMenu.Item
											variant="danger"
											icon={<Trash className="size-4" aria-hidden="true" />}
											onClick={onDelete}
										>
											{onDeleteThread ? t`Delete comment` : t`Delete`}
										</DropdownMenu.Item>
									)}
									{onDeleteThread && (
										<DropdownMenu.Item
											variant="danger"
											icon={<Trash className="size-4" aria-hidden="true" />}
											onClick={onDeleteThread}
										>
											{t`Delete thread`}
										</DropdownMenu.Item>
									)}
								</DropdownMenu.Content>
							</DropdownMenu>
						)}
					</div>
				)}
			</div>
			{editing ? (
				<div className="ps-8" onClick={(event) => event.stopPropagation()}>
					<CommentComposer
						entry={entry}
						value={body}
						onChange={setBody}
						autoFocus
						label={t`Edit comment`}
						placeholder={t`Comment`}
						submitLabel={t`Save`}
						pending={editPending}
						onCancel={() => setEditing(false)}
						onSubmit={() => onEdit(draftToBody(body), () => setEditing(false))}
					/>
				</div>
			) : deleted ? (
				<p className="ps-8 text-kumo-subtle italic">{t`Comment deleted`}</p>
			) : (
				<p className="ps-8 whitespace-pre-wrap break-words">
					<MentionText body={comment.body} people={people} />
					{comment.editedAt && <span className="ms-1 text-xs text-kumo-subtle">{t`(edited)`}</span>}
				</p>
			)}
		</li>
	);
}
