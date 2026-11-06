import { Badge, Button, DropdownMenu, InputArea } from "@cloudflare/kumo";
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
import { getEditorialHighlights } from "../editor/EditorialCommentsExtension.js";
import {
	bodyToDraft,
	draftToBody,
	MentionText,
	useMentionPicker,
	type MentionDraft,
} from "./mentions.js";
import { EDITORIAL_DOCUMENT_FIELD, type EditorialCommentsState } from "./useEditorialComments.js";

const CARD_GAP_PX = 8;
const WHITESPACE = /\s+/;
const EMPTY_DRAFT: MentionDraft = { text: "", mentions: [] };

export interface EditorialCommentsUser {
	id: string;
	name?: string | null;
	avatarUrl?: string | null;
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

/** Vertical positions for cards beside their anchors, pushed down so none overlap. */
function useCardLayout(
	editor: Editor | null,
	gutterRef: React.RefObject<HTMLDivElement | null>,
	positionedIds: string[],
	draftFrom: number | null,
	enabled: boolean,
) {
	const cardRefs = React.useRef(new Map<string, HTMLElement>());
	const [tops, setTops] = React.useState<Record<string, number>>({});
	const [version, setVersion] = React.useState(0);

	React.useEffect(() => {
		if (!editor || !enabled) return;
		let frame = 0;
		const bump = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setVersion((value) => value + 1));
		};
		editor.on("transaction", bump);
		// Fields above the editor, such as an image that finishes loading, move the text without resizing it.
		const observer = new ResizeObserver(bump);
		observer.observe(editor.view.dom.closest(".emdash-editor-page") ?? editor.view.dom);
		if (gutterRef.current) observer.observe(gutterRef.current);
		return () => {
			cancelAnimationFrame(frame);
			editor.off("transaction", bump);
			observer.disconnect();
		};
	}, [editor, enabled, gutterRef]);

	React.useLayoutEffect(() => {
		const gutter = gutterRef.current;
		if (!editor || editor.isDestroyed || !gutter || !enabled) return;
		const origin = gutter.getBoundingClientRect().top;
		const ranges = new Map(
			getEditorialHighlights(editor.state).map((highlight) => [highlight.threadId, highlight]),
		);
		const wanted = positionedIds
			.map((id) => {
				const from = id === "draft" ? draftFrom : ranges.get(id)?.from;
				if (from == null) return null;
				return { id, top: editor.view.coordsAtPos(from).top - origin };
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
	}, [editor, gutterRef, positionedIds, draftFrom, enabled, version]);

	const register = React.useCallback(
		(id: string) => (element: HTMLElement | null) => {
			if (element) cardRefs.current.set(id, element);
			else cardRefs.current.delete(id);
		},
		[],
	);

	return { tops, register };
}

/**
 * Comment threads in the margin beside the entry. Text and block threads sit
 * next to what they point at; entry, field and detached threads head the
 * column. Below the large breakpoint the cards stack in a list instead.
 */
export function MarginComments({
	comments,
	editor,
	currentUser,
	fieldLabels,
	positioned,
	canComment,
}: {
	comments: EditorialCommentsState;
	editor: Editor | null;
	currentUser: EditorialCommentsUser | undefined;
	fieldLabels: Record<string, string>;
	positioned: boolean;
	canComment: boolean;
}) {
	const { t } = useLingui();
	const gutterRef = React.useRef<HTMLDivElement>(null);
	const { threads, highlights, activeThreadId, draft, showResolved } = comments;

	const located = React.useMemo(() => new Set(highlights.map((h) => h.threadId)), [highlights]);
	const visible = threads.filter(
		(thread) => thread.status === "open" || showResolved || thread.id === activeThreadId,
	);
	const inPlace = positioned ? visible.filter((thread) => located.has(thread.id)) : [];
	const listed = visible.filter((thread) => !inPlace.includes(thread));
	const draftInPlace = positioned && draft?.range != null;
	const positionedIds = React.useMemo(
		() => [...inPlace.map((thread) => thread.id), ...(draftInPlace ? ["draft"] : [])],
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the set of ids changes
		[inPlace.map((thread) => thread.id).join(), draftInPlace],
	);
	const { tops, register } = useCardLayout(
		editor,
		gutterRef,
		positionedIds,
		draft?.range?.from ?? null,
		positioned,
	);
	const resolvedCount = threads.filter((thread) => thread.status === "resolved").length;

	const draftCard = draft && (
		<DraftCard
			key="draft"
			quote={draft.anchor.type === "text" ? draft.anchor.quote : null}
			entry={comments.entry}
			currentUser={currentUser}
			pending={comments.actions.createThread.isPending}
			onCancel={() => comments.setDraft(null)}
			onSubmit={(body) => comments.actions.createThread.mutate({ anchor: draft.anchor, body })}
		/>
	);

	return (
		<aside aria-label={t`Comments`} className="flex flex-col gap-3">
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
							onClick={comments.startComment}
						>
							{t`Comment`}
						</Button>
					)}
				</div>
			</div>

			{!draftInPlace && draftCard}
			{listed.map((thread) => (
				<ThreadCard
					key={thread.id}
					thread={thread}
					comments={comments}
					editor={editor}
					inPlace={false}
					fieldLabels={fieldLabels}
					detached={
						(thread.anchor.type === "text" || thread.anchor.type === "block") &&
						thread.anchor.field === EDITORIAL_DOCUMENT_FIELD &&
						!located.has(thread.id)
					}
					canComment={canComment}
				/>
			))}
			{threads.length === 0 && !draft && !comments.isLoading && (
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
								editor={editor}
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
	);
}

function DraftCard({
	quote,
	entry,
	currentUser,
	pending,
	onCancel,
	onSubmit,
}: {
	quote: string | null;
	entry: EditorialEntry | null;
	currentUser: EditorialCommentsUser | undefined;
	pending: boolean;
	onCancel: () => void;
	onSubmit: (body: string) => void;
}) {
	const { t } = useLingui();
	const [body, setBody] = React.useState(EMPTY_DRAFT);
	return (
		<div className="rounded-lg border border-kumo-brand bg-kumo-base p-3 shadow-sm">
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
			{quote && <Quote text={quote} />}
			<CommentComposer
				entry={entry}
				value={body}
				onChange={setBody}
				autoFocus
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
				rows={2}
				autoFocus={autoFocus}
				{...picker.textareaProps}
				onChange={(event) => {
					onChange({ ...value, text: event.target.value });
					picker.syncCaret(event);
				}}
				onKeyDown={(event) => {
					if (picker.handleKeyDown(event)) return;
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !empty) {
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
		</div>
	);
}

function ThreadCard({
	thread,
	comments,
	editor,
	inPlace,
	fieldLabels,
	detached,
	canComment,
}: {
	thread: EditorialThread;
	comments: EditorialCommentsState;
	editor: Editor | null;
	inPlace: boolean;
	fieldLabels: Record<string, string>;
	detached: boolean;
	canComment: boolean;
}) {
	const { t, i18n } = useLingui();
	const anchorLabel = useAnchorLabel();
	const active = comments.activeThreadId === thread.id;
	const [reply, setReply] = React.useState(EMPTY_DRAFT);
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
		if (!editor || editor.isDestroyed) return;
		const highlight = getEditorialHighlights(editor.state).find((h) => h.threadId === thread.id);
		if (!highlight) return;
		const dom = editor.view.nodeDOM(highlight.from);
		const target =
			dom instanceof HTMLElement ? dom : editor.view.domAtPos(highlight.from).node.parentElement;
		target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	};

	const visibleComments = active ? thread.comments : thread.comments.slice(0, 1);
	const hiddenReplies = thread.comments.length - visibleComments.length;

	return (
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
				"rounded-lg border bg-kumo-base p-3 text-sm transition-shadow",
				active ? "border-kumo-brand shadow-md" : "cursor-pointer border-kumo-line hover:shadow-sm",
				resolved && "opacity-75",
			)}
		>
			<div className="mb-2 flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-1.5">
					{heading && <span className="truncate text-xs text-kumo-subtle">{heading}</span>}
					{detached && <Badge variant="secondary">{t`Detached`}</Badge>}
					{resolved && <Badge variant="secondary">{t`Resolved`}</Badge>}
				</div>
				<div className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
					{thread.can.resolve && (
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
					)}
					{thread.can.delete && (
						<Button
							variant="ghost"
							size="sm"
							shape="square"
							type="button"
							aria-label={t`Delete thread`}
							title={t`Delete thread`}
							disabled={actions.deleteThread.isPending}
							onClick={() => actions.deleteThread.mutate(thread.id)}
						>
							<Trash className="size-4" aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>

			{thread.anchor.type === "text" && (detached || !active) && (
				<Quote text={thread.anchor.quote} detached={detached} />
			)}

			<ol className="flex flex-col gap-3">
				{visibleComments.map((comment) => (
					<CommentItem
						key={comment.id}
						comment={comment}
						entry={comments.entry}
						people={thread.mentions}
						locale={i18n.locale}
						onEdit={(body) =>
							actions.editComment.mutate({ threadId: thread.id, commentId: comment.id, body })
						}
						onDelete={() =>
							actions.deleteComment.mutate({ threadId: thread.id, commentId: comment.id })
						}
					/>
				))}
			</ol>
			{hiddenReplies > 0 && (
				<p className="mt-2 text-xs text-kumo-subtle">
					{plural(hiddenReplies, { one: "# reply", other: "# replies" })}
				</p>
			)}

			{active && canComment && (
				<div className="mt-3" onClick={(event) => event.stopPropagation()}>
					<CommentComposer
						entry={comments.entry}
						value={reply}
						onChange={setReply}
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
	);
}

function CommentItem({
	comment,
	entry,
	people,
	locale,
	onEdit,
	onDelete,
}: {
	comment: EditorialComment;
	entry: EditorialEntry | null;
	people: EditorialPerson[];
	locale: string;
	onEdit: (body: string) => void;
	onDelete: () => void;
}) {
	const { t } = useLingui();
	const [editing, setEditing] = React.useState(false);
	const [body, setBody] = React.useState(EMPTY_DRAFT);
	const deleted = comment.deletedAt !== null;
	const name = comment.author?.name ?? (comment.author ? t`Unnamed user` : t`Deleted user`);

	return (
		<li className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<Avatar person={comment.author} />
				<div className="flex min-w-0 flex-1 items-baseline gap-1.5">
					<span className="truncate font-medium">{name}</span>
					<time dateTime={comment.createdAt} className="shrink-0 text-xs text-kumo-subtle">
						<bdi>{formatRelativeTime(comment.createdAt, locale)}</bdi>
					</time>
				</div>
				{(comment.can.edit || comment.can.delete) && !editing && (
					<div onClick={(event) => event.stopPropagation()}>
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
										onClick={() => {
											setBody(bodyToDraft(comment.body, people));
											setEditing(true);
										}}
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
										{t`Delete`}
									</DropdownMenu.Item>
								)}
							</DropdownMenu.Content>
						</DropdownMenu>
					</div>
				)}
			</div>
			{editing ? (
				<div onClick={(event) => event.stopPropagation()}>
					<CommentComposer
						entry={entry}
						value={body}
						onChange={setBody}
						autoFocus
						label={t`Edit comment`}
						placeholder={t`Comment`}
						submitLabel={t`Save`}
						pending={false}
						onCancel={() => setEditing(false)}
						onSubmit={() => {
							onEdit(draftToBody(body));
							setEditing(false);
						}}
					/>
				</div>
			) : deleted ? (
				<p className="text-kumo-subtle italic">{t`Comment deleted`}</p>
			) : (
				<p className="whitespace-pre-wrap break-words">
					<MentionText body={comment.body} people={people} />
					{comment.editedAt && <span className="ms-1 text-xs text-kumo-subtle">{t`(edited)`}</span>}
				</p>
			)}
		</li>
	);
}
