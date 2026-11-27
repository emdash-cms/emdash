/**
 * Self-contained inline Portable Text editor for visual editing.
 *
 * Uses the admin editor's Portable Text schema and converter, with its own
 * node views (`inline-portable-text-schema.ts`), so both editors read and
 * write rich text the same way. Includes the admin editor's selection
 * toolbar and slash menu, and a toolbar and picker for images, but no fixed
 * toolbar, sidebar, or section picker.
 *
 * Auto-saves on blur, dispatches custom events for toolbar integration.
 */

import {
	createEditorialCommentsExtension,
	type EditorialCommentsBridge,
} from "@emdash-cms/admin/internal/editorial-editor";
import {
	UnsafePortableTextTableError,
	UnsupportedPortableTextMarksError,
	portableTextToProsemirror,
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import Focus from "@tiptap/extension-focus";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import type { Transaction } from "@tiptap/pm/state";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { exitSuggestion } from "@tiptap/suggestion";
import * as React from "react";

import { InlineBubbleMenu } from "./inline-bubble-menu.js";
import { INLINE_EDITOR_UI_STYLES, useInlineUiRoot } from "./inline-editor-ui.js";
import {
	INLINE_EDITORIAL_STYLES,
	useInlineEditorialComments,
} from "./inline-editorial-comments.js";
import { INLINE_IMAGE_STYLES, insertImage } from "./inline-image.js";
import { INLINE_MEDIA_PICKER_STYLES, InlineMediaPicker } from "./inline-media-picker.js";
import {
	DEFAULT_TABLE_PLACEHOLDER,
	INLINE_PLUGIN_BLOCK_TYPES,
	inlinePortableTextExtensions,
} from "./inline-portable-text-schema.js";
import {
	InlineSlashMenu,
	createSlashCommandsExtension,
	initialSlashMenuState,
	type SlashCommandItem,
	type SlashMenuState,
} from "./inline-slash-menu.js";

// ── Helpers ────────────────────────────────────────────────────────

/** The entry revision a successful save response reports, if it has one. */
async function savedRev(response: Response): Promise<string | undefined> {
	try {
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("data" in body)) return undefined;
		const { data } = body;
		if (!data || typeof data !== "object" || !("_rev" in data)) return undefined;
		return typeof data._rev === "string" ? data._rev : undefined;
	} catch {
		return undefined;
	}
}

function getUnsupportedFileGuidance(locale: string): string {
	if (locale.toLowerCase().startsWith("ar")) {
		return "لا يمكن إفلات الملفات أو لصقها هنا. اكتب /image لاختيار صورة من مكتبة الوسائط.";
	}
	return "Files can’t be dropped or pasted here. Type /image to choose an image from the media library.";
}

function hasTransferredFiles(transfer: DataTransfer | null): boolean {
	if (!transfer) return false;
	if (transfer.files.length > 0) return true;
	for (let index = 0; index < transfer.items.length; index++) {
		if (transfer.items[index]?.kind === "file") return true;
	}
	return false;
}

function createUnsupportedFileHandlers(showGuidance: () => void) {
	const keepFileDragInEditor = (_view: unknown, event: DragEvent): boolean => {
		if (!hasTransferredFiles(event.dataTransfer)) return false;
		event.preventDefault();
		return true;
	};
	return {
		handleDOMEvents: {
			dragenter: keepFileDragInEditor,
			dragover: keepFileDragInEditor,
			drop: (_view: unknown, event: DragEvent): boolean => {
				if (!hasTransferredFiles(event.dataTransfer)) return false;
				event.preventDefault();
				showGuidance();
				return true;
			},
			paste: (_view: unknown, event: ClipboardEvent): boolean => {
				if (!hasTransferredFiles(event.clipboardData)) return false;
				event.preventDefault();
				showGuidance();
				return true;
			},
		},
	};
}

// ── Component ──────────────────────────────────────────────────────

export interface InlinePortableTextEditorProps {
	value: PortableTextBlock[];
	collection: string;
	entryId: string;
	field: string;
	tablePlaceholder?: string;
}

export function InlinePortableTextEditor({
	value,
	collection,
	entryId,
	field,
	tablePlaceholder = DEFAULT_TABLE_PLACEHOLDER,
}: InlinePortableTextEditorProps) {
	const initialRef = React.useRef(value);
	// The editor document last known to be stored: the one the loaded content
	// produced, then the one each successful save sent. `save()` does nothing
	// while the current document is structurally equal to it (`Node.eq`).
	const savedDocRef = React.useRef<Editor["state"]["doc"] | null>(null);
	const savingRef = React.useRef(false);
	const editorRef = React.useRef<ReturnType<typeof useEditor>>(null);

	// Where the image picker that `/image` opened will put the image.
	const [imagePickerAt, setImagePickerAt] = React.useState<number | null>(null);
	const [unsupportedFileGuidance, setUnsupportedFileGuidance] = React.useState<{
		message: string;
		version: number;
	} | null>(null);
	const showUnsupportedFileGuidance = React.useCallback(() => {
		const locale = document.documentElement.lang || navigator.language;
		setUnsupportedFileGuidance((current) => ({
			message: getUnsupportedFileGuidance(locale),
			version: (current?.version ?? 0) + 1,
		}));
	}, []);
	const unsupportedFileHandlers = React.useMemo(
		() => createUnsupportedFileHandlers(showUnsupportedFileGuidance),
		[showUnsupportedFileGuidance],
	);

	const uiRoot = useInlineUiRoot();

	// The Suggestion plugin's key handlers read the slash menu's state as soon
	// as it changes, before React commits it, so the ref takes each change
	// synchronously and the extension, created once, reads the ref.
	const [slashMenuState, setSlashMenuStateRaw] =
		React.useState<SlashMenuState>(initialSlashMenuState);
	const slashMenuStateRef = React.useRef(slashMenuState);
	const setSlashMenuState: React.Dispatch<React.SetStateAction<SlashMenuState>> = React.useCallback(
		(action) => {
			const next = typeof action === "function" ? action(slashMenuStateRef.current) : action;
			slashMenuStateRef.current = next;
			setSlashMenuStateRaw(next);
		},
		[],
	);
	const slashMenuActionsRef = React.useRef({
		run: (_item: SlashCommandItem) => {},
		dismiss: () => {},
	});

	const editorialBridgeRef = React.useRef<EditorialCommentsBridge>({});
	const editorialCommentsExtension = React.useMemo(
		() => createEditorialCommentsExtension(editorialBridgeRef),
		[],
	);
	const [rootElement, setRootElement] = React.useState<HTMLDivElement | null>(null);
	const saveRef = React.useRef<() => void>(() => {});
	const syncAnchorsRef = React.useRef<(rev: string | undefined) => void>(() => {});

	const [loadState] = React.useState<{
		content: ReturnType<typeof portableTextToProsemirror>;
		error: UnsupportedPortableTextMarksError | UnsafePortableTextTableError | null;
	}>(() => {
		try {
			return {
				content: portableTextToProsemirror(value || [], INLINE_PLUGIN_BLOCK_TYPES),
				error: null,
			};
		} catch (error) {
			if (
				error instanceof UnsupportedPortableTextMarksError ||
				error instanceof UnsafePortableTextTableError
			) {
				return {
					content: { type: "doc", content: [{ type: "paragraph" }] },
					error,
				};
			}
			throw error;
		}
	});

	const initialContent = loadState.content;
	const loadError = loadState.error;
	const [saveError, setSaveError] = React.useState<string | null>(null);

	const getBlocks = React.useCallback((): PortableTextBlock[] => {
		const editor = editorRef.current;
		if (!editor) return initialRef.current;
		return prosemirrorToPortableText(editor.getJSON());
	}, []);

	const save = React.useCallback(
		async (options?: { keepalive?: boolean }) => {
			// A pagehide flush must not be skipped: an in-flight blur save is
			// cancelled by the navigation, so the keepalive request is the only
			// one that can still land.
			if (loadError) return;
			if (savingRef.current && !options?.keepalive) return;

			const doc = editorRef.current?.state.doc;
			if (!doc || !savedDocRef.current || doc.eq(savedDocRef.current)) return;

			savingRef.current = true;
			let settle = () => {};
			const done = new Promise<void>((resolve) => {
				settle = () => resolve();
			});
			// The visual-editing toolbar holds Publish until `done` settles.
			document.dispatchEvent(new CustomEvent("emdash:save-pending", { detail: { done } }));
			try {
				const blocks = getBlocks();
				const res = await fetch(
					`/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}`,
					{
						method: "PUT",
						credentials: "same-origin",
						headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
						body: JSON.stringify({ data: { [field]: blocks }, skipRevision: true }),
						keepalive: options?.keepalive ?? false,
					},
				);

				if (res.ok) {
					setSaveError(null);
					initialRef.current = blocks;
					savedDocRef.current = doc;
					syncAnchorsRef.current(await savedRev(res));
					document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "saved" } }));
					document.dispatchEvent(
						new CustomEvent("emdash:content-changed", {
							detail: { collection, id: entryId },
						}),
					);
				} else {
					setSaveError(`Save failed: ${res.status}`);
					document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
					console.error("Save failed:", res.status);
				}
			} catch (err) {
				setSaveError(
					err instanceof UnsupportedPortableTextMarksError
						? `Save failed: unsupported formatting (${err.marks.join(", ")}).`
						: "Save failed. Please try again.",
				);
				document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
				console.error("Save failed:", err);
			} finally {
				savingRef.current = false;
				settle();
			}
		},
		[collection, entryId, field, getBlocks, loadError],
	);

	// Flush unsaved edits when the page goes away (browser back/forward,
	// link click, tab close). The blur handler doesn't cover this: unload
	// doesn't reliably fire React blur, and a plain fetch started during
	// unload is cancelled by the navigation — edits were silently lost.
	// `keepalive` lets the PUT outlive the page.
	// Caveat: keepalive caps the body at 64KB — a very long document
	// can still be lost on unload. Upgrade path: debounced autosave
	// while typing (like the admin editor) so unload flushes are rare.
	React.useEffect(() => {
		const flush = () => void save({ keepalive: true });
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [save]);

	// Create slash commands extension once — uses refs to avoid re-render loop
	const slashCommandsExtension = React.useMemo(
		() =>
			createSlashCommandsExtension({
				onStateChange: setSlashMenuState,
				getState: () => slashMenuStateRef.current,
				onCommand: (item) => slashMenuActionsRef.current.run(item),
				onDismiss: () => slashMenuActionsRef.current.dismiss(),
			}),
		[setSlashMenuState],
	);
	const schemaExtensions = React.useMemo(
		() => inlinePortableTextExtensions({ tablePlaceholder }),
		[tablePlaceholder],
	);

	const editor = useEditor({
		extensions: [
			...schemaExtensions,
			Placeholder.configure({
				includeChildren: true,
				placeholder: ({ node }) => {
					if (node.type.name === "paragraph") return "Type / for commands...";
					return "";
				},
			}),
			Focus.configure({
				className: "has-focus",
				mode: "all",
			}),
			Typography,
			editorialCommentsExtension,
			slashCommandsExtension,
		],
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the converter builds documents for this schema
		content: initialContent as Parameters<typeof useEditor>[0]["content"],
		immediatelyRender: false,
		editorProps: {
			attributes: {
				"aria-label": "Rich text editor",
				class: "prose prose-sm sm:prose-base dark:prose-invert max-w-none emdash-inline-editor",
				dir: "auto",
			},
			...unsupportedFileHandlers,
		},
		onUpdate: () => {
			document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "unsaved" } }));
		},
	});

	const saveBeforeDraft = React.useCallback(() => saveRef.current(), []);
	const editorialComments = useInlineEditorialComments({
		editor,
		bridge: editorialBridgeRef,
		root: rootElement,
		collection,
		entryId,
		field,
		beforeDraft: saveBeforeDraft,
	});
	saveRef.current = () => void save();
	syncAnchorsRef.current = editorialComments.syncAnchors;

	// Store editor ref for getBlocks, and record the loaded document as saved.
	React.useEffect(() => {
		editorRef.current = editor;
		if (editor && !savedDocRef.current) {
			// TrailingNode normalizes on the first transaction, even a selection change.
			// Include that normalization in the baseline without dirtying the toolbar
			// or making it part of the first edit's undo history.
			editor.view.dispatch(
				editor.state.tr.setMeta("preventUpdate", true).setMeta("addToHistory", false),
			);
			savedDocRef.current = editor.state.doc;
		}
	}, [editor]);

	const runSlashCommand = React.useCallback(
		(item: SlashCommandItem) => {
			const { range } = slashMenuStateRef.current;
			if (!editor || !range) return;
			item.command({
				editor,
				range,
				openImagePicker: () => setImagePickerAt(editor.state.selection.from),
			});
			setSlashMenuState((prev) => ({ ...prev, isOpen: false }));
		},
		[editor, setSlashMenuState],
	);
	/** Closes the slash menu without a command, keeping what was typed. */
	const closeSlashMenu = React.useCallback(() => {
		const { range } = slashMenuStateRef.current;
		setSlashMenuState((prev) => ({
			...prev,
			isOpen: false,
			dismissedSlashFrom: range ? range.from : prev.dismissedSlashFrom,
		}));
		if (editor && range) exitSuggestion(editor.view);
	}, [editor, setSlashMenuState]);
	slashMenuActionsRef.current = { run: runSlashCommand, dismiss: closeSlashMenu };

	// Edits made while the picker is open, as when focus stays in the editor, move the spot it inserts at.
	const pickerOpen = imagePickerAt !== null;
	React.useEffect(() => {
		if (!editor || !pickerOpen) return;
		const onTransaction = ({ transaction }: { transaction: Transaction }) => {
			if (!transaction.docChanged) return;
			setImagePickerAt((at) => (at === null ? at : transaction.mapping.map(at)));
		};
		editor.on("transaction", onTransaction);
		return () => {
			editor.off("transaction", onTransaction);
		};
	}, [editor, pickerOpen]);

	// The image picker opens at the caret the `/image` command left.
	const caretReference = React.useMemo(
		() =>
			editor && imagePickerAt !== null
				? {
						getBoundingClientRect: () => {
							if (editor.isDestroyed) return new DOMRect();
							const { view } = editor;
							const caret = view.coordsAtPos(Math.min(imagePickerAt, view.state.doc.content.size));
							return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
						},
						contextElement: editor.view.dom,
					}
				: null,
		[editor, imagePickerAt],
	);

	// Save on blur — but not when interacting with slash menu or image picker
	const handleBlur = React.useCallback(
		(e: React.FocusEvent<HTMLDivElement>) => {
			const related = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
			if (related && e.currentTarget.contains(related)) return;
			// The copy fallback briefly moves focus to its textarea before restoring the editor.
			if (related?.hasAttribute("data-emdash-clipboard-fallback")) return;
			// The toolbars, menus, and image picker live in a root of their own at the end of the page.
			if (related && uiRoot?.contains(related)) return;
			// A toolbar button keeps focus in the editor, so the toolbars skip
			// the editor's next blur; telling them again lets them hide. It waits
			// for this blur to finish, which may be a toolbar removing itself.
			const event = e.nativeEvent;
			queueMicrotask(() => {
				if (!editor || editor.isDestroyed || editor.view.hasFocus()) return;
				if (uiRoot?.contains(document.activeElement)) return;
				editor.view.dispatch(editor.state.tr.setMeta("blur", { event }));
			});
			void save();
		},
		[editor, save, uiRoot],
	);

	if (!editor || !uiRoot) return null;

	return (
		<div ref={setRootElement} onBlur={handleBlur}>
			{loadError instanceof UnsupportedPortableTextMarksError ? (
				<div className="emdash-inline-editor-error" role="alert" dir="auto">
					This field can’t be edited here because it contains unsupported Portable Text marks:{" "}
					{loadError.marks.join(", ")}.
				</div>
			) : loadError ? (
				<div className="emdash-inline-editor-error" role="alert" dir="auto">
					This field can’t be edited here because it contains a table the editor can’t open. Edit it
					in the admin.
				</div>
			) : (
				<>
					<InlineBubbleMenu
						editor={editor}
						uiRoot={uiRoot}
						onImageReplaced={() => void save()}
						comment={
							editorialComments.labels
								? {
										label: editorialComments.labels.commentOnSelection,
										onClick: editorialComments.startComment,
									}
								: undefined
						}
					/>
					<EditorContent editor={editor} />
				</>
			)}
			{saveError ? (
				<div className="emdash-inline-editor-error" role="alert" dir="auto">
					{saveError}
				</div>
			) : null}
			{unsupportedFileGuidance ? (
				<div
					key={unsupportedFileGuidance.version}
					className="emdash-inline-editor-guidance"
					role="status"
					aria-live="polite"
					dir="auto"
				>
					{unsupportedFileGuidance.message}
				</div>
			) : null}
			{editorialComments.notice ? (
				<div className="emdash-inline-editor-guidance" role="status" aria-live="polite" dir="auto">
					{editorialComments.notice}
				</div>
			) : null}
			<InlineSlashMenu
				editor={editor}
				uiRoot={uiRoot}
				state={slashMenuState}
				onCommand={runSlashCommand}
				onClose={closeSlashMenu}
				setSelectedIndex={(index) =>
					setSlashMenuState((prev) => ({ ...prev, selectedIndex: index }))
				}
			/>
			{imagePickerAt !== null && caretReference && (
				<InlineMediaPicker
					uiRoot={uiRoot}
					reference={caretReference}
					gap={6}
					label="Insert image"
					onChoose={(image) => {
						insertImage(editor, imagePickerAt, image);
						editor.view.focus();
						setImagePickerAt(null);
						void save();
					}}
					onClose={(reason) => {
						if (reason !== "blur") editor.view.focus();
						setImagePickerAt(null);
					}}
				/>
			)}
			<style>{`
				.emdash-inline-code-block {
					position: relative;
					margin-block: 1rem;
					--emdash-code-background: var(--emdash-inline-code-background, #f7f7f5);
					--emdash-code-foreground: var(--emdash-inline-code-foreground, #24292f);
					--emdash-code-muted: var(--emdash-inline-code-muted, #57606a);
					--emdash-code-keyword: var(--emdash-inline-code-keyword, #b8172a);
					--emdash-code-string: var(--emdash-inline-code-string, #0a3069);
					--emdash-code-number: var(--emdash-inline-code-number, #0550ae);
					--emdash-code-title: var(--emdash-inline-code-title, #7545c7);
					--emdash-code-border: var(--emdash-inline-code-border, #7d8590);
					--emdash-code-control-background: var(
						--emdash-inline-code-control-background,
						var(--emdash-inline-bg, #ffffff)
					);
					--emdash-code-control-foreground: var(
						--emdash-inline-code-control-foreground,
						#24292f
					);
					--emdash-code-focus: var(--emdash-inline-code-focus, #0550ae);
				}
				.emdash-inline-code-block .emdash-code-block {
					margin: 0;
					padding: 1rem;
					padding-block: 30px !important;
					border: 0 !important;
					border-radius: 0.5rem;
					background: var(--emdash-code-background) !important;
					color: var(--emdash-code-foreground) !important;
					caret-color: var(--emdash-code-foreground) !important;
					overflow-x: auto;
				}
				.emdash-inline-code-block .emdash-code-block code {
					background: transparent !important;
					color: inherit !important;
					font-size: 13px !important;
				}
				.emdash-inline-code-block :is(.hljs-comment, .hljs-quote) {
					color: var(--emdash-code-muted);
				}
				.emdash-inline-code-block
					:is(.hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-section, .hljs-link, .hljs-deletion) {
					color: var(--emdash-code-keyword);
				}
				.emdash-inline-code-block
					:is(.hljs-string, .hljs-attr, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition) {
					color: var(--emdash-code-string);
				}
				.emdash-inline-code-block :is(.hljs-number, .hljs-meta) {
					color: var(--emdash-code-number);
				}
				.emdash-inline-code-block
					:is(.hljs-title, .hljs-name, .hljs-type, .hljs-built_in, .hljs-selector-id, .hljs-selector-class) {
					color: var(--emdash-code-title);
				}
				.emdash-inline-code-block-popover,
				.emdash-inline-code-block-chip {
					box-sizing: border-box;
					border: 1px solid var(--emdash-code-border);
					background: var(--emdash-code-control-background);
					color: var(--emdash-code-control-foreground);
				}
				.emdash-inline-code-block-controls-wrap {
					position: absolute;
					inset-block-start: 0;
					inset-inline-end: 0.25rem;
					z-index: 100;
					max-inline-size: min(calc(100% - 0.25rem), calc(100vw - 1rem));
					opacity: 0;
					pointer-events: none;
					user-select: none;
					transition: opacity 120ms ease-out;
				}
				.emdash-inline-code-block:hover .emdash-inline-code-block-controls-wrap,
				.emdash-inline-code-block:focus-within .emdash-inline-code-block-controls-wrap,
				.emdash-inline-code-block-controls-wrap[data-persistent="true"] {
					opacity: 1;
					pointer-events: auto;
				}
				.emdash-inline-code-block-popover {
					inline-size: min(14rem, 100%, calc(100vw - 1rem));
				}
				.emdash-inline-code-block-language-input {
					min-inline-size: 0;
					flex: 1;
					border: 1px solid var(--emdash-code-border);
					background: transparent;
					color: inherit;
				}
				.emdash-inline-code-block-controls-wrap button:focus-visible,
				.emdash-inline-code-block-language-input:focus-visible {
					outline: 2px solid var(--emdash-code-focus);
					outline-offset: 2px;
				}
				@media (hover: none), (pointer: coarse) {
					.emdash-inline-code-block-controls-wrap {
						opacity: 1;
						pointer-events: auto;
					}
				}
				@media (prefers-reduced-motion: reduce) {
					.emdash-inline-code-block-controls-wrap {
						transition: none;
					}
				}
				@media (prefers-color-scheme: dark) {
					.emdash-inline-code-block {
						--emdash-code-background: var(--emdash-inline-code-background, #202020);
						--emdash-code-foreground: var(--emdash-inline-code-foreground, #f0f3f6);
						--emdash-code-muted: var(--emdash-inline-code-muted, #c9d1d9);
						--emdash-code-keyword: var(--emdash-inline-code-keyword, #ffc1bb);
						--emdash-code-string: var(--emdash-inline-code-string, #b9ddff);
						--emdash-code-number: var(--emdash-inline-code-number, #a8d5ff);
						--emdash-code-title: var(--emdash-inline-code-title, #e5ccff);
						--emdash-code-border: var(--emdash-inline-code-border, #6e7681);
						--emdash-code-control-background: var(
							--emdash-inline-code-control-background,
							var(--emdash-inline-bg, #161b22)
						);
						--emdash-code-control-foreground: var(
							--emdash-inline-code-control-foreground,
							#f0f3f6
						);
						--emdash-code-focus: var(--emdash-inline-code-focus, #a8d5ff);
					}
				}
				.emdash-inline-editor .emdash-slash-query {
					margin-inline: -0.25em;
					padding: 0.125em 0.25em;
					border-radius: 0.375rem;
					background: color-mix(in srgb, currentColor 8%, transparent);
				}
				.emdash-inline-editor .emdash-slash-query.is-empty::after {
					content: "Type to search";
					color: color-mix(in srgb, currentColor 45%, transparent);
					pointer-events: none;
				}
				${INLINE_EDITOR_UI_STYLES}
				${INLINE_MEDIA_PICKER_STYLES}
				${INLINE_IMAGE_STYLES}
				${INLINE_EDITORIAL_STYLES}
				.emdash-inline-editor:focus {
					outline: none;
				}
				.emdash-inline-editor:focus p.is-editor-empty {
					display: flow-root;
				}
				.emdash-inline-editor:focus p.is-editor-empty::before {
					content: attr(data-placeholder);
					float: inline-start;
					width: 100%;
					margin-inline-end: -100%;
					opacity: 0.5;
					pointer-events: none;
				}
				.emdash-inline-editor-guidance {
					margin-block-start: 0.75rem;
					padding-block: 0.625rem;
					padding-inline: 0.875rem;
					border: 1px solid #bfdbfe;
					border-radius: 0.5rem;
					background: #eff6ff;
					color: #1e3a8a;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					line-height: 1.4;
					text-align: start;
				}
				.emdash-inline-editor-error {
					margin-block-start: 0.75rem;
					padding-block: 0.625rem;
					padding-inline: 0.875rem;
					border: 1px solid #fecaca;
					border-radius: 0.5rem;
					background: #fef2f2;
					color: #991b1b;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					line-height: 1.4;
					text-align: start;
				}
				.emdash-plugin-block-placeholder {
					margin: 0.75rem 0;
					padding: 0.625rem 0.875rem;
					border: 1px dashed #d1d5db;
					border-radius: 0.5rem;
					background: #f9fafb;
					color: #4b5563;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					user-select: none;
				}
				@media (prefers-color-scheme: dark) {
					.emdash-inline-editor-guidance {
						border-color: #1e40af;
						background: #172554;
						color: #dbeafe;
					}
					.emdash-inline-editor-error {
						border-color: #991b1b;
						background: #450a0a;
						color: #fee2e2;
					}
					.emdash-plugin-block-placeholder {
						border-color: #374151;
						background: #111827;
						color: #9ca3af;
					}
				}
			`}</style>
		</div>
	);
}

// Test-only exports for unit tests.
export { createUnsupportedFileHandlers as _createUnsupportedFileHandlers };
