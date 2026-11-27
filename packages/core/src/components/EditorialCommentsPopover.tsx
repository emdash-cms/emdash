/**
 * The visual editing toolbar's comment popover. The toolbar draws the badges
 * itself and loads this module the first time someone opens one, through the
 * island on the `/_emdash/visual-editing/comments` page. It reaches the module
 * through `EditorialCommentsHost.mount`.
 */

import {
	FloatingFocusManager,
	FloatingPortal,
	autoUpdate,
	flip,
	offset,
	shift,
	useDismiss,
	useFloating,
	useInteractions,
	useMergeRefs,
	useRole,
} from "@floating-ui/react";
import { X } from "@phosphor-icons/react";
import * as React from "react";
import { createRoot } from "react-dom/client";

import { INLINE_EDITOR_UI_STYLES, useInlineUiRoot } from "./inline-editor-ui.js";

export interface CommentsPerson {
	id: string;
	name: string | null;
}

export interface CommentsCommentView {
	id: string;
	author: CommentsPerson | null;
	body: string;
	createdAt: string;
	deletedAt: string | null;
}

export interface CommentsThreadView {
	id: string;
	anchor: { type: string; field?: string; quote?: string };
	status: "open" | "resolved";
	comments: CommentsCommentView[];
	mentions?: CommentsPerson[];
	can?: { resolve?: boolean };
}

export interface CommentsLabels {
	openInAdmin: string;
	noOpenComments: string;
	newComment: string;
	comment: string;
	writeReply: string;
	reply: string;
	resolve: string;
	close: string;
	commentDeleted: string;
	deletedUser: string;
	unknownUser: string;
	unnamedUser: string;
	onField: string;
	onQuote: string;
	onBlock: string;
	commentsLoadFailed: string;
	commentActionFailed: string;
}

export interface CommentsPopoverOptions {
	/** The badge that opened the popover; focus goes back to it on Escape or Close. */
	anchor: HTMLElement;
	title: string;
	/** The top-level field new threads go on, or `null` for entry threads. */
	field: string | null;
	threads: CommentsThreadView[];
	/** Labels for the fields of threads shown in an entry's popover. */
	fieldLabels?: Record<string, string>;
	loadFailed: boolean;
	labels: CommentsLabels;
	/** `/_emdash/api/content/{collection}/{id}/threads` */
	threadsUrl: string;
	/** `/_emdash/admin/content/{collection}/{id}` */
	adminUrl: string;
	adminTarget: string;
	/** Sends a thread write and resolves to the thread it returns. */
	request: (url: string, method: "POST" | "PATCH", payload: unknown) => Promise<CommentsThreadView>;
	onThreadChange: (thread: CommentsThreadView) => void;
	onClose: () => void;
}

export interface CommentsPopoverHandle {
	open(options: CommentsPopoverOptions): void;
	close(): void;
}

const MENTION_RE = /<@([^<>\s]{1,64})>/g;
const TYPED_TOKEN_START_RE = /<@/g;
const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * Kept by thread while the popover is closed: unsent text, and sends still in
 * flight, with the text they sent and whether they were saved.
 */
interface Sending {
	sent: string;
	saved: Promise<boolean>;
}

interface DraftStore {
	text: Map<string, string>;
	sending: Map<string, Sending>;
}

function createDraftStore(): DraftStore {
	return { text: new Map(), sending: new Map() };
}

const DraftsContext = React.createContext<DraftStore>(createDraftStore());

function fillLabel(label: string, values: Record<string, string>): string {
	return label.replace(PLACEHOLDER_RE, (match, name: string) => values[name] ?? match);
}

function personName(person: CommentsPerson, unnamed: string): string {
	return person.name?.trim() || unnamed;
}

function CommentText({
	text,
	names,
	unknown,
}: {
	text: string;
	names: Map<string, string>;
	unknown: string;
}) {
	const parts: React.ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(MENTION_RE)) {
		if (match.index > last) parts.push(text.slice(last, match.index));
		parts.push(
			<span key={match.index} className="emdash-comments-mention">
				@{names.get(match[1]!) ?? unknown}
			</span>,
		);
		last = match.index + match[0].length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return <>{parts}</>;
}

function formatTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CommentForm({
	label,
	submitLabel,
	failedLabel,
	draftKey,
	textareaRef,
	onSubmit,
	children,
}: {
	label: string;
	submitLabel: string;
	failedLabel: string;
	draftKey: string;
	textareaRef?: React.Ref<HTMLTextAreaElement>;
	onSubmit: (body: string) => Promise<void>;
	children?: (setError: (message: string) => void) => React.ReactNode;
}) {
	const id = React.useId();
	const drafts = React.useContext(DraftsContext);
	const [value, setValue] = React.useState(() => drafts.text.get(draftKey) ?? "");
	const [error, setError] = React.useState("");
	const formRef = React.useRef<HTMLFormElement>(null);

	function change(next: string) {
		setValue(next);
		if (next) drafts.text.set(draftKey, next);
		else drafts.text.delete(draftKey);
	}

	// A send outlives the popover that started it, so a reopened form waits for
	// it instead of allowing it to be sent again.
	const [sending, setSending] = React.useState(() => drafts.sending.get(draftKey) ?? null);
	const busy = sending !== null;
	React.useEffect(() => {
		if (!sending) return;
		let mounted = true;
		const settle = async () => {
			const saved = await sending.saved;
			if (!mounted) return;
			setSending(null);
			if (saved) setValue((current) => (current === sending.sent ? "" : current));
			else setError(failedLabel);
		};
		void settle();
		return () => {
			mounted = false;
		};
	}, [sending, failedLabel]);

	function submit(event: React.FormEvent) {
		event.preventDefault();
		const text = value.trim();
		if (!text || busy) return;
		const sent = value;
		const saved = onSubmit(text.replace(TYPED_TOKEN_START_RE, "<\u200B@")).then(
			() => true,
			(err: unknown) => {
				console.error("[emdash] Comment request failed:", err);
				return false;
			},
		);
		const next = { sent, saved };
		drafts.sending.set(draftKey, next);
		const forget = async () => {
			const ok = await saved;
			drafts.sending.delete(draftKey);
			if (ok && drafts.text.get(draftKey) === sent) drafts.text.delete(draftKey);
		};
		void forget();
		setError("");
		setSending(next);
	}

	return (
		<form ref={formRef} className="emdash-comments-form" onSubmit={submit}>
			<label htmlFor={id} className="emdash-inline-ui-sr-only">
				{label}
			</label>
			<textarea
				ref={textareaRef}
				id={id}
				className="emdash-inline-ui-input emdash-comments-textarea"
				placeholder={label}
				required
				readOnly={busy}
				dir="auto"
				value={value}
				onChange={(event) => change(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
						event.preventDefault();
						formRef.current?.requestSubmit();
					}
				}}
			/>
			<div className="emdash-comments-actions">
				<button type="submit" className="emdash-comments-button" data-primary="" disabled={busy}>
					{submitLabel}
				</button>
				{children?.(setError)}
			</div>
			<p className="emdash-inline-ui-field-error" role="alert">
				{error}
			</p>
		</form>
	);
}

function Thread({
	thread,
	options,
	textareaRef,
	onChange,
}: {
	thread: CommentsThreadView;
	options: CommentsPopoverOptions;
	textareaRef: (element: HTMLTextAreaElement | null) => void;
	onChange: (thread: CommentsThreadView, focus: string) => void;
}) {
	const { labels } = options;
	const names = new Map<string, string>();
	for (const person of thread.mentions ?? []) {
		names.set(person.id, personName(person, labels.unnamedUser));
	}
	const threadUrl = `${options.threadsUrl}/${encodeURIComponent(thread.id)}`;
	const [resolving, setResolving] = React.useState(false);
	const otherField = options.field === null ? thread.anchor.field : undefined;

	return (
		<li className="emdash-comments-thread">
			{otherField && (
				<p className="emdash-comments-quote">
					{fillLabel(labels.onField, { field: options.fieldLabels?.[otherField] ?? otherField })}
				</p>
			)}
			{thread.anchor.type === "text" && (
				<p className="emdash-comments-quote" dir="auto" title={thread.anchor.quote}>
					{fillLabel(labels.onQuote, { quote: thread.anchor.quote ?? "" })}
				</p>
			)}
			{thread.anchor.type === "block" && <p className="emdash-comments-quote">{labels.onBlock}</p>}
			{thread.comments.map((comment) => (
				<div key={comment.id}>
					<div className="emdash-comments-meta">
						<span className="emdash-comments-author">
							{comment.author ? personName(comment.author, labels.unnamedUser) : labels.deletedUser}
						</span>
						<time dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time>
					</div>
					{comment.deletedAt ? (
						<p className="emdash-comments-text" data-deleted="">
							{labels.commentDeleted}
						</p>
					) : (
						<p className="emdash-comments-text" dir="auto">
							<CommentText text={comment.body} names={names} unknown={labels.unknownUser} />
						</p>
					)}
				</div>
			))}
			<CommentForm
				label={labels.writeReply}
				submitLabel={labels.reply}
				failedLabel={labels.commentActionFailed}
				draftKey={`${threadUrl} reply`}
				textareaRef={textareaRef}
				onSubmit={async (body) => {
					onChange(await options.request(`${threadUrl}/comments`, "POST", { body }), thread.id);
				}}
			>
				{(setError) => (
					<>
						{thread.can?.resolve && (
							<button
								type="button"
								className="emdash-comments-button"
								disabled={resolving}
								onClick={async () => {
									setResolving(true);
									setError("");
									try {
										onChange(
											await options.request(threadUrl, "PATCH", { status: "resolved" }),
											"dialog",
										);
									} catch (err) {
										console.error("[emdash] Resolve failed:", err);
										setResolving(false);
										setError(labels.commentActionFailed);
									}
								}}
							>
								{labels.resolve}
							</button>
						)}
						<a
							className="emdash-comments-admin"
							href={`${options.adminUrl}?thread=${encodeURIComponent(thread.id)}`}
							target={options.adminTarget}
						>
							{labels.openInAdmin}
						</a>
					</>
				)}
			</CommentForm>
		</li>
	);
}

function CommentsPopover({
	options,
	onDismiss,
}: {
	options: CommentsPopoverOptions;
	onDismiss: () => void;
}) {
	const { anchor, labels } = options;
	const [threads, setThreads] = React.useState(options.threads);
	const [focus, setFocus] = React.useState<string | null>(null);
	const dialogRef = React.useRef<HTMLDivElement | null>(null);
	const anchorRef = React.useRef<HTMLElement | null>(anchor);
	const newCommentRef = React.useRef<HTMLTextAreaElement | null>(null);
	const replyRefs = React.useRef(new Map<string, HTMLTextAreaElement>());
	const titleId = React.useId();

	const { refs, floatingStyles, context } = useFloating({
		open: true,
		onOpenChange: (open) => {
			if (!open) onDismiss();
		},
		elements: { reference: anchor },
		placement: "bottom-end",
		middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
		whileElementsMounted: autoUpdate,
	});
	const dismiss = useDismiss(context, {
		// The badge toggles the popover itself.
		outsidePress: (event) => !(event.target instanceof Node && anchor.contains(event.target)),
	});
	const role = useRole(context, { role: "dialog" });
	const { getFloatingProps } = useInteractions([dismiss, role]);
	const setDialog = useMergeRefs([refs.setFloating, dialogRef]);

	React.useEffect(() => {
		if (focus === null) return;
		const target =
			focus === "new" ? newCommentRef.current : (replyRefs.current.get(focus) ?? dialogRef.current);
		target?.focus();
		setFocus(null);
	}, [focus]);

	function change(thread: CommentsThreadView, nextFocus: string) {
		setThreads((current) => {
			const index = current.findIndex((existing) => existing.id === thread.id);
			if (thread.status !== "open") return current.filter((existing) => existing.id !== thread.id);
			if (index === -1) return [...current, thread];
			return current.map((existing) => (existing.id === thread.id ? thread : existing));
		});
		options.onThreadChange(thread);
		setFocus(nextFocus);
	}

	return (
		<FloatingFocusManager
			context={context}
			modal={false}
			initialFocus={dialogRef}
			returnFocus={anchorRef}
		>
			<div
				ref={setDialog}
				style={floatingStyles}
				className="emdash-inline-ui-menu emdash-comments"
				tabIndex={-1}
				aria-labelledby={titleId}
				data-emdash-comments=""
				{...getFloatingProps()}
			>
				<div className="emdash-comments-header">
					<h2 id={titleId} className="emdash-comments-title">
						{options.title}
					</h2>
					<button
						type="button"
						className="emdash-inline-ui-button"
						aria-label={labels.close}
						title={labels.close}
						onClick={onDismiss}
					>
						<X aria-hidden="true" />
					</button>
				</div>
				<div className="emdash-comments-body">
					{options.loadFailed && (
						<p className="emdash-inline-ui-field-error" role="alert">
							{labels.commentsLoadFailed}
						</p>
					)}
					{threads.length ? (
						<ul className="emdash-comments-threads">
							{threads.map((thread) => (
								<Thread
									key={thread.id}
									thread={thread}
									options={options}
									onChange={change}
									textareaRef={(element) => {
										if (element) replyRefs.current.set(thread.id, element);
										else replyRefs.current.delete(thread.id);
									}}
								/>
							))}
						</ul>
					) : options.loadFailed ? null : (
						<p className="emdash-comments-empty">{labels.noOpenComments}</p>
					)}
					<CommentForm
						label={labels.newComment}
						submitLabel={labels.comment}
						failedLabel={labels.commentActionFailed}
						draftKey={`${options.threadsUrl} new ${options.field ?? ""}`}
						textareaRef={newCommentRef}
						onSubmit={async (body) => {
							const anchorValue = options.field
								? { type: "field", field: options.field }
								: { type: "entry" };
							change(
								await options.request(options.threadsUrl, "POST", { anchor: anchorValue, body }),
								"new",
							);
						}}
					/>
				</div>
			</div>
		</FloatingFocusManager>
	);
}

function CommentsLayer({
	current,
	drafts,
	onDismiss,
}: {
	current: { options: CommentsPopoverOptions; key: number } | null;
	drafts: DraftStore;
	onDismiss: () => void;
}) {
	const root = useInlineUiRoot();
	if (!root) return null;
	return (
		<FloatingPortal root={root}>
			<style>{COMMENTS_STYLES}</style>
			{current && (
				<DraftsContext.Provider value={drafts}>
					<CommentsPopover key={current.key} options={current.options} onDismiss={onDismiss} />
				</DraftsContext.Provider>
			)}
		</FloatingPortal>
	);
}

/** Mounts the popover's root at the end of `document.body`; it shows one popover at a time. */
export function mountEditorialComments(): CommentsPopoverHandle {
	const container = document.createElement("div");
	container.style.display = "contents";
	document.body.append(container);
	const root = createRoot(container);
	const drafts = createDraftStore();
	let current: { options: CommentsPopoverOptions; key: number } | null = null;
	let nextKey = 0;

	function render() {
		root.render(<CommentsLayer current={current} drafts={drafts} onDismiss={dismiss} />);
	}
	function dismiss() {
		const closing = current;
		current = null;
		render();
		closing?.options.onClose();
	}

	return {
		open(options) {
			const replaced = current;
			current = { options, key: ++nextKey };
			render();
			replaced?.options.onClose();
		},
		close() {
			if (current) dismiss();
		},
	};
}

/**
 * The island Astro builds this module from. It renders nothing; the toolbar
 * imports the module and calls `mount`.
 */
export const EditorialCommentsHost = Object.assign(
	function EditorialCommentsHost() {
		return null;
	},
	{ mount: mountEditorialComments },
);

const COMMENTS_STYLES = `
	${INLINE_EDITOR_UI_STYLES}
	.emdash-comments {
		display: flex;
		flex-direction: column;
		width: 340px;
		max-width: calc(100vw - 16px);
		max-height: min(480px, 70vh);
		padding: 0;
		overflow: hidden;
	}
	.emdash-comments:focus-visible {
		box-shadow: 0 0 0 2px var(--emdash-ui-brand), var(--emdash-ui-shadow);
	}
	.emdash-comments-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-block: 4px;
		padding-inline: 12px 4px;
		border-block-end: 1px solid var(--emdash-ui-hairline);
	}
	.emdash-comments-title {
		margin: 0;
		color: var(--emdash-ui-text);
		font-size: 14px;
		font-weight: 600;
		line-height: 20px;
	}
	.emdash-comments-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.emdash-comments-threads {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.emdash-comments-thread {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border-radius: 8px;
		background: var(--emdash-ui-tint);
	}
	.emdash-comments-quote {
		display: -webkit-box;
		margin: 0;
		padding-inline-start: 8px;
		overflow: hidden;
		border-inline-start: 2px solid var(--emdash-ui-brand);
		color: var(--emdash-ui-subtle);
		font-size: 12px;
		line-height: 16px;
		overflow-wrap: anywhere;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
	}
	.emdash-comments-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px;
		color: var(--emdash-ui-subtle);
		font-size: 12px;
		line-height: 16px;
	}
	.emdash-comments-author {
		color: var(--emdash-ui-text);
		font-weight: 600;
	}
	.emdash-comments-text {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.emdash-comments-text[data-deleted] {
		color: var(--emdash-ui-subtle);
		font-style: italic;
	}
	.emdash-comments-mention {
		color: var(--emdash-ui-link);
		font-weight: 600;
	}
	.emdash-comments-empty {
		margin: 0;
		color: var(--emdash-ui-subtle);
	}
	.emdash-comments-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
	}
	.emdash-inline-ui .emdash-comments-textarea {
		width: 100%;
		height: auto;
		min-height: 56px;
		padding-block: 6px;
		font: inherit;
		resize: vertical;
	}
	.emdash-comments-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.emdash-inline-ui .emdash-comments-button {
		height: 28px;
		padding: 0 10px;
		border: 0;
		border-radius: 6px;
		background: var(--emdash-ui-surface);
		box-shadow: 0 0 0 1px var(--emdash-ui-line);
		font-size: 13px;
		cursor: pointer;
	}
	.emdash-inline-ui .emdash-comments-button:hover {
		background: var(--emdash-ui-fill);
	}
	.emdash-inline-ui .emdash-comments-button[data-primary] {
		background: var(--emdash-ui-brand);
		box-shadow: none;
		color: #fff;
	}
	.emdash-inline-ui .emdash-comments-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.emdash-inline-ui .emdash-comments-button:focus-visible,
	.emdash-inline-ui .emdash-comments-admin:focus-visible {
		outline: 2px solid var(--emdash-ui-brand);
		outline-offset: 2px;
	}
	.emdash-inline-ui .emdash-comments-admin {
		margin-inline-start: auto;
		color: var(--emdash-ui-link);
		font-size: 13px;
		text-decoration: underline;
	}
	.emdash-comments .emdash-inline-ui-field-error:empty {
		display: none;
	}
`;
