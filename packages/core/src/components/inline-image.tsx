/**
 * Images in the inline editor. Each shows as the page will publish it, with
 * its caption typed right underneath, and a selected image gets a toolbar to
 * replace it, describe it, or delete it: the admin editor's image toolbar
 * without alignment, link, and settings.
 */

import type { VirtualElement } from "@floating-ui/react";
import { Check, ImageSquare, TextAa, Trash, X } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import {
	NodeViewWrapper,
	ReactNodeViewRenderer,
	useEditorState,
	type NodeViewProps,
} from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import * as React from "react";

import {
	TOOLBAR_POPUP_ATTR,
	ToolbarButton,
	ToolbarSeparator,
	ToolbarShownContext,
	ToolbarTextButton,
	ToolbarTooltipGroup,
	attachBeforePositioning,
	handleToolbarKeyDown,
	playToolbarEntrance,
} from "./inline-editor-ui.js";
import { InlineMediaPicker, type ChosenImage } from "./inline-media-picker.js";

type ShouldShow = NonNullable<BubbleMenuProps["shouldShow"]>;

const IMAGE_TOOLBAR_KEY = "emdashInlineImageToolbar";
const TOOLBAR_CONTROL_SELECTOR = "button:not([disabled]), a[href], input";
/** A toolbar shown again within this long of hiding, as when its caption takes focus, doesn't rise in again. */
const RESHOW_WITHOUT_ENTRANCE_MS = 100;
const CAPTION_PLACEHOLDER = "Add a caption";

type ImageAlignment = "left" | "center" | "right" | "wide" | "full";

function alignmentOf(value: unknown): ImageAlignment | undefined {
	return value === "left" ||
		value === "center" ||
		value === "right" ||
		value === "wide" ||
		value === "full"
		? value
		: undefined;
}

function dimension(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The size the image is published at: its own, or the display size set for it. */
function renderSize(attrs: Record<string, unknown>): { width?: number; height?: number } {
	const width = dimension(attrs.width);
	const height = dimension(attrs.height);
	const displayWidth = dimension(attrs.displayWidth);
	const displayHeight = dimension(attrs.displayHeight);
	const ratio = width && height ? width / height : undefined;
	if (displayWidth && displayHeight) return { width: displayWidth, height: displayHeight };
	if (displayWidth && ratio) {
		return { width: displayWidth, height: Math.round(displayWidth / ratio) };
	}
	if (displayHeight && ratio) {
		return { width: Math.round(displayHeight * ratio), height: displayHeight };
	}
	return { width, height };
}

export function selectedImage(state: EditorState): NodeSelection | null {
	const { selection } = state;
	return selection instanceof NodeSelection && selection.node.type.name === "image"
		? selection
		: null;
}

function captionField(editor: Editor, position: number): HTMLTextAreaElement | null {
	const dom = editor.view.nodeDOM(position);
	return dom instanceof HTMLElement ? dom.querySelector("figcaption textarea") : null;
}

/**
 * TipTap checks its toolbars again when the editor gains focus. A caption
 * taking focus from the editor hid its image's toolbar, and selecting an
 * image that was already selected changes nothing that would show it again.
 */
function showToolbarsAgain(editor: Editor) {
	editor.view.dispatch(
		editor.state.tr.setMeta("focus", { event: undefined }).setMeta("addToHistory", false),
	);
}

/**
 * Puts an image where the caret was, as a block of its own at the top of
 * the document: in place of an empty line, or before or after the block the
 * caret is in. Lists and quotes keep only their text when saved, so an image
 * never goes inside one; an empty line there goes, and the image follows
 * the list or quote, or takes its place when that line was all it held. The
 * new image ends up selected.
 */
export function insertImage(editor: Editor, position: number, image: ChosenImage) {
	editor.commands.command(({ tr, state }) => {
		const type = state.schema.nodes.image;
		if (!type) return false;
		const $pos = tr.doc.resolve(Math.min(position, tr.doc.content.size));
		const node = type.create(image);
		const emptyLine = $pos.parent.isTextblock && $pos.parent.childCount === 0;
		// The outermost block that holds nothing but the caret's line.
		let depth = $pos.depth;
		while (depth > 1 && $pos.node(depth - 1).childCount === 1) depth--;
		let at: number;
		if ($pos.depth === 0) {
			at = $pos.pos;
			tr.insert(at, node);
		} else if (emptyLine && depth === 1) {
			at = $pos.before(1);
			tr.replaceWith(at, $pos.after(1), node);
		} else if ($pos.depth === 1 && $pos.parentOffset === 0) {
			at = $pos.before(1);
			tr.insert(at, node);
		} else {
			const after = $pos.after(1);
			// An empty line takes its list item with it when it was the item's only line.
			if (emptyLine) tr.deleteRange($pos.before(), $pos.after());
			at = tr.mapping.map(after);
			tr.insert(at, node);
		}
		tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView();
		return true;
	});
}

/** Whether `size` has `picture`'s shape, within a pixel of rounding either way. */
function hasShape(
	size: { width?: unknown; height?: unknown },
	picture: { width?: unknown; height?: unknown },
): boolean {
	const width = dimension(size.width);
	const height = dimension(size.height);
	const pictureWidth = dimension(picture.width);
	const pictureHeight = dimension(picture.height);
	if (!width || !height || !pictureWidth || !pictureHeight) return false;
	return (
		Math.abs(width * pictureHeight - height * pictureWidth) <= Math.max(pictureWidth, pictureHeight)
	);
}

/**
 * Shows another image in the image at `position`. The caption belongs to its
 * place in the post, so it stays; the alt text and title described the old
 * picture, so they come from the new one. A display size in the old
 * picture's shape would crop a new picture of another shape, so only its
 * width stays. A display size in another shape crops on purpose, as an
 * imported WordPress thumbnail does, and stays whole.
 */
export function replaceImage(editor: Editor, position: number, image: ChosenImage) {
	editor.commands.command(({ tr }) => {
		const node = tr.doc.nodeAt(position);
		if (node?.type.name !== "image") return false;
		const attrs: Record<string, unknown> = node.attrs;
		const display = { width: attrs.displayWidth, height: attrs.displayHeight };
		const dropsHeight = hasShape(display, attrs) && !hasShape(display, image);
		tr.setNodeMarkup(position, undefined, {
			...attrs,
			...image,
			title: null,
			...(dropsHeight ? { displayHeight: null } : {}),
		});
		tr.setSelection(NodeSelection.create(tr.doc, position));
		return true;
	});
}

// Firefox can't select text by mouse inside a draggable element, and the image's node view is one.
function setNodeViewDraggable(event: React.PointerEvent<HTMLTextAreaElement>, draggable: boolean) {
	if (event.pointerType !== "mouse") return;
	const nodeView = event.currentTarget.closest<HTMLElement>("[draggable]");
	if (nodeView) nodeView.draggable = draggable;
}

// TipTap keeps drags over the image from the editor, which accepts a dragged file
// only to refuse it on drop. A file dropped where nothing accepted it opens in the tab.
function keepFileDragInEditor(event: React.DragEvent) {
	if (event.dataTransfer.types.includes("Files")) event.preventDefault();
}

/** The image as Image.astro publishes it, with its caption as a field. */
function InlineImageView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
	const attrs: Record<string, unknown> = node.attrs;
	const src = typeof attrs.src === "string" ? attrs.src : "";
	const alt = typeof attrs.alt === "string" ? attrs.alt : "";
	const title = typeof attrs.title === "string" && attrs.title ? attrs.title : undefined;
	const caption = typeof attrs.caption === "string" ? attrs.caption : "";
	const alignment = alignmentOf(attrs.alignment);
	const { width, height } = renderSize(attrs);
	const captionRef = React.useRef<HTMLTextAreaElement>(null);

	// ProseMirror would take text dragged over or dropped on the caption into the document.
	React.useEffect(() => {
		const textarea = captionRef.current;
		if (!textarea) return;
		const keepTextDrag = (event: DragEvent) => {
			if (!event.dataTransfer?.types.includes("Files")) event.stopPropagation();
		};
		textarea.addEventListener("dragover", keepTextDrag);
		textarea.addEventListener("drop", keepTextDrag);
		return () => {
			textarea.removeEventListener("dragover", keepTextDrag);
			textarea.removeEventListener("drop", keepTextDrag);
		};
	}, []);

	const select = () => {
		const position = getPos();
		if (typeof position === "number") editor.commands.setNodeSelection(position);
	};
	const selectFromPointer = (event: React.MouseEvent) => {
		// The caption selects the image once it has focus, so the toolbar sees that focus.
		if (event.target instanceof Element && event.target.closest("figcaption")) return;
		select();
	};

	const onCaptionKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		const position = getPos();
		if (typeof position !== "number") return;
		if (event.key === "Enter") {
			// A caption is one line of text, so Enter starts a paragraph after the image.
			event.preventDefault();
			const after = position + node.nodeSize;
			editor
				.chain()
				.insertContentAt(after, { type: "paragraph" })
				.focus(after + 1)
				.run();
		} else if (event.key === "Escape" || (event.key === "Tab" && event.shiftKey)) {
			event.preventDefault();
			editor.commands.setNodeSelection(position);
			editor.view.focus();
		}
		// Tab goes on to the image's toolbar, as from any selection in the editor.
	};

	return (
		<NodeViewWrapper
			as="figure"
			className={alignment ? `emdash-image emdash-image--align-${alignment}` : "emdash-image"}
			onPointerDown={(event: React.PointerEvent) => {
				// A finger pressing on the image may be scrolling the page, so a tap selects it on click.
				if (event.pointerType === "mouse" && event.isPrimary && event.button === 0) {
					selectFromPointer(event);
				}
			}}
			onClick={selectFromPointer}
			onDragEnter={keepFileDragInEditor}
			onDragOver={keepFileDragInEditor}
		>
			<img
				src={src}
				alt={alt}
				title={title}
				width={width}
				height={height}
				draggable={false}
				data-drag-handle=""
			/>
			<figcaption data-value={caption || CAPTION_PLACEHOLDER}>
				<textarea
					ref={captionRef}
					rows={1}
					tabIndex={-1}
					dir="auto"
					value={caption}
					placeholder={CAPTION_PLACEHOLDER}
					aria-label="Caption"
					onChange={(event) => updateAttributes({ caption: event.target.value })}
					onFocus={() => {
						select();
						showToolbarsAgain(editor);
					}}
					onKeyDown={onCaptionKeyDown}
					onPointerEnter={(event) => setNodeViewDraggable(event, false)}
					onPointerLeave={(event) => setNodeViewDraggable(event, true)}
				/>
			</figcaption>
		</NodeViewWrapper>
	);
}

export const InlineImageExtension = Image.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			mediaId: { default: null },
			provider: { default: null },
			width: { default: null },
			height: { default: null },
			displayWidth: { default: null },
			displayHeight: { default: null },
			caption: { default: null },
			blurhash: { default: null },
			dominantColor: { default: null },
			alignment: { default: null, rendered: false },
			link: { default: null, rendered: false },
		};
	},

	addNodeView() {
		return ReactNodeViewRenderer(InlineImageView);
	},

	addKeyboardShortcuts() {
		return {
			// From a selected image, Tab goes to its caption, and from there to its toolbar.
			Tab: ({ editor }) => {
				const selection = selectedImage(editor.state);
				const caption = selection && captionField(editor, selection.from);
				if (!caption) return false;
				caption.focus();
				return true;
			},
		};
	},
});

function AltTextField({
	value,
	onChange,
	onSave,
	onCancel,
}: {
	value: string;
	onChange: (value: string) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	const inputRef = React.useRef<HTMLInputElement>(null);
	React.useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	return (
		<div className="emdash-inline-ui-field-row">
			<input
				ref={inputRef}
				type="text"
				dir="auto"
				autoComplete="off"
				className="emdash-inline-ui-input"
				value={value}
				placeholder="Describe the image"
				aria-label="Alt text"
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.keyCode === 229) return;
					if (event.key === "Enter") {
						event.preventDefault();
						onSave();
					} else if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
			/>
			<ToolbarButton label="Cancel" onClick={onCancel}>
				<X />
			</ToolbarButton>
			<ToolbarButton label="Save alt text" onClick={onSave}>
				<Check />
			</ToolbarButton>
		</div>
	);
}

/** The toolbar over a selected image: Replace, Alt text, and Delete. */
export function InlineImageToolbar({
	editor,
	uiRoot,
	scrollTarget,
	onReplaced,
}: {
	editor: Editor;
	uiRoot: HTMLElement;
	scrollTarget: HTMLElement | undefined;
	onReplaced: () => void;
}) {
	const [mode, setMode] = React.useState<"controls" | "alt">("controls");
	const [replacing, setReplacing] = React.useState(false);
	const [shown, setShown] = React.useState(false);
	const [draft, setDraft] = React.useState("");
	const menuRef = React.useRef<HTMLDivElement>(null);
	const replaceRef = React.useRef<HTMLButtonElement>(null);
	const hiddenAtRef = React.useRef(Number.NEGATIVE_INFINITY);
	const image = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => {
			const selection = selectedImage(activeEditor.state);
			const attrs: Record<string, unknown> | undefined = selection?.node.attrs;
			return {
				position: selection?.from ?? null,
				alt: typeof attrs?.alt === "string" ? attrs.alt : "",
				mediaId: typeof attrs?.mediaId === "string" ? attrs.mediaId : "",
				provider: typeof attrs?.provider === "string" && attrs.provider ? attrs.provider : "local",
			};
		},
	});
	const described = image.alt.trim() !== "";

	// An alt text draft or a picker belongs to the image it was opened for.
	React.useEffect(() => {
		setMode("controls");
		setReplacing(false);
	}, [image.position]);

	// The field and the buttons differ in width, so the toolbar centers over the image again.
	React.useEffect(() => {
		if (shown && !editor.isDestroyed) {
			editor.view.dispatch(editor.state.tr.setMeta(IMAGE_TOOLBAR_KEY, "updatePosition"));
		}
	}, [editor, mode, shown]);

	const appendTo = React.useCallback(() => uiRoot, [uiRoot]);
	const options = React.useMemo(
		() => ({
			strategy: "absolute" as const,
			placement: "top" as const,
			offset: 10,
			flip: { padding: 8 },
			shift: { padding: 8 },
			size: {
				padding: 8,
				apply: ({
					availableWidth,
					elements,
				}: {
					availableWidth: number;
					elements: { floating: HTMLElement };
				}) => {
					elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
				},
			},
			scrollTarget,
			onShow: () => {
				setShown(true);
				if (performance.now() - hiddenAtRef.current > RESHOW_WITHOUT_ENTRANCE_MS) {
					playToolbarEntrance(menuRef.current?.firstElementChild);
				}
			},
			onHide: () => {
				hiddenAtRef.current = performance.now();
				setShown(false);
				setMode("controls");
				setReplacing(false);
			},
		}),
		[scrollTarget],
	);
	const shouldShow = React.useCallback<ShouldShow>(
		({ editor: activeEditor, element, state, view }) => {
			const selection = selectedImage(state);
			if (!activeEditor.isEditable || !selection) return false;
			// TipTap's timers can run this after the editor is gone, when the global document may be too.
			const activeElement = element.ownerDocument.activeElement;
			const show =
				view.hasFocus() ||
				element.contains(activeElement) ||
				Boolean(activeElement?.closest(`[${TOOLBAR_POPUP_ATTR}]`)) ||
				// The image's caption.
				Boolean(view.nodeDOM(selection.from)?.contains(activeElement));
			if (show) attachBeforePositioning(element, uiRoot);
			return show;
		},
		[uiRoot],
	);

	// The picker opens below the toolbar, growing from the Replace button, and
	// follows the toolbar when TipTap moves it.
	const pickerReference = React.useMemo<VirtualElement>(
		() => ({
			getBoundingClientRect: () => menuRef.current?.getBoundingClientRect() ?? new DOMRect(),
			get contextElement() {
				return menuRef.current ?? undefined;
			},
		}),
		[],
	);
	const pickerOrigin = React.useCallback(
		() => replaceRef.current?.getBoundingClientRect() ?? new DOMRect(),
		[],
	);

	// Focus goes back to Replace before the picker leaves the page, so it never drops to the page.
	const closeReplace = () => {
		replaceRef.current?.focus({ preventScroll: true });
		setReplacing(false);
	};
	const replace = (chosen: ChosenImage) => {
		// The image it already shows keeps the alt text and title written for it.
		if (chosen.mediaId === image.mediaId && chosen.provider === image.provider) {
			closeReplace();
			return;
		}
		if (image.position !== null) replaceImage(editor, image.position, chosen);
		closeReplace();
		onReplaced();
	};
	const editAlt = () => {
		// Focus waits on the toolbar while the button it was on, or the picker, goes away.
		const activeElement = document.activeElement;
		if (
			menuRef.current?.contains(activeElement) ||
			activeElement?.closest(`[${TOOLBAR_POPUP_ATTR}]`)
		) {
			menuRef.current?.focus({ preventScroll: true });
		}
		setReplacing(false);
		setDraft(image.alt);
		setMode("alt");
	};
	// The editor takes focus before the field goes, so focus never drops to the page.
	const backToEditor = () => {
		editor.view.focus();
		setMode("controls");
	};
	const saveAlt = () => {
		const alt = draft.trim();
		if (alt !== image.alt.trim()) editor.commands.updateAttributes("image", { alt: alt || null });
		backToEditor();
	};
	const remove = () => {
		editor.view.focus();
		editor.commands.deleteSelection();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		// Shift+Tab from the first control goes back to the caption, which Tab came from.
		if (event.key === "Tab" && event.shiftKey && image.position !== null) {
			const caption = captionField(editor, image.position);
			const first = event.currentTarget.querySelector(TOOLBAR_CONTROL_SELECTOR);
			if (caption && document.activeElement === first) {
				event.preventDefault();
				caption.focus();
				return;
			}
		}
		handleToolbarKeyDown(event, editor);
	};

	return (
		<>
			<BubbleMenu
				ref={menuRef}
				editor={editor}
				pluginKey={IMAGE_TOOLBAR_KEY}
				appendTo={appendTo}
				updateDelay={0}
				options={options}
				shouldShow={shouldShow}
				role="toolbar"
				aria-label="Image controls"
				className="emdash-inline-ui-bar emdash-image-bubble-menu"
				onMouseDown={() => {
					// TipTap skips the editor's next blur after a press on its toolbar. With
					// focus in the caption or the toolbar, no such blur comes to use that up,
					// and the one that hides the toolbar later would be skipped instead.
					if (!editor.view.hasFocus()) {
						editor.view.dispatch(
							editor.state.tr.setMeta("blur", { event: { relatedTarget: menuRef.current } }),
						);
					}
				}}
				onKeyDown={onKeyDown}
			>
				<ToolbarShownContext.Provider value={shown}>
					<ToolbarTooltipGroup>
						{mode === "alt" ? (
							<AltTextField
								value={draft}
								onChange={setDraft}
								onSave={saveAlt}
								onCancel={backToEditor}
							/>
						) : (
							<>
								<ToolbarTextButton
									label="Replace"
									icon={<ImageSquare aria-hidden="true" />}
									expanded={replacing}
									buttonRef={replaceRef}
									onClick={() => (replacing ? closeReplace() : setReplacing(true))}
								/>
								<ToolbarTextButton
									label="Alt text"
									icon={<TextAa aria-hidden="true" />}
									pressed={described}
									tooltip={described ? image.alt.trim() : "No description yet"}
									onClick={editAlt}
								/>
								<ToolbarSeparator />
								<ToolbarButton label="Delete image" onClick={remove}>
									<Trash />
								</ToolbarButton>
							</>
						)}
					</ToolbarTooltipGroup>
				</ToolbarShownContext.Provider>
			</BubbleMenu>
			{replacing && image.position !== null && (
				<InlineMediaPicker
					uiRoot={uiRoot}
					reference={pickerReference}
					origin={pickerOrigin}
					gap={4}
					label="Replace image"
					current={{ provider: image.provider, mediaId: image.mediaId }}
					fromToolbar
					onChoose={replace}
					onClose={(reason) => (reason === "blur" ? setReplacing(false) : closeReplace())}
				/>
			)}
		</>
	);
}

/**
 * The image's look while editing: Image.astro's own styles, which the page
 * applies to published images, and a caption field that grows with its text.
 */
export const INLINE_IMAGE_STYLES = `
	.emdash-inline-editor .emdash-image {
		margin: 1.5rem 0;
	}
	.emdash-inline-editor .emdash-image img {
		max-width: 100%;
		height: auto;
	}
	.emdash-inline-editor .ProseMirror-selectednode > .emdash-image > img {
		outline: 2px solid oklch(57.72% 0.2324 260);
		outline-offset: 3px;
	}
	.emdash-inline-editor .emdash-image figcaption {
		display: grid;
		margin-top: 0.5rem;
		color: var(--emdash-caption-color, var(--color-muted, #666));
		font-size: 0.875rem;
		text-align: center;
	}
	/* An invisible copy of the text sizes the cell the field fills, so the field grows as it wraps. */
	.emdash-inline-editor .emdash-image figcaption::after,
	.emdash-inline-editor .emdash-image figcaption textarea {
		grid-area: 1 / 1;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
		font: inherit;
		letter-spacing: inherit;
		line-height: inherit;
		text-align: inherit;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.emdash-inline-editor .emdash-image figcaption::after {
		content: attr(data-value) " ";
		visibility: hidden;
	}
	.emdash-inline-editor .emdash-image figcaption textarea {
		display: block;
		width: 100%;
		height: 100%;
		overflow: hidden;
		resize: none;
		background: transparent;
		color: inherit;
		outline: none;
	}
	.emdash-inline-editor .emdash-image figcaption textarea::placeholder {
		color: inherit;
		opacity: 0.6;
	}
	.emdash-inline-editor .emdash-image figcaption textarea:focus-visible {
		border-radius: 2px;
		outline: 2px solid color-mix(in srgb, currentColor 35%, transparent);
		outline-offset: 2px;
	}
	.emdash-inline-editor .emdash-image--align-left,
	.emdash-inline-editor .emdash-image--align-right {
		width: fit-content;
		max-width: 50%;
	}
	.emdash-inline-editor .emdash-image--align-left {
		float: left;
		margin: 0 1.5rem 1rem 0;
	}
	.emdash-inline-editor .emdash-image--align-right {
		float: right;
		margin: 0 0 1rem 1.5rem;
	}
	.emdash-inline-editor .emdash-image--align-center {
		width: fit-content;
		margin-inline: auto;
	}
	.emdash-inline-editor .emdash-image--align-wide,
	.emdash-inline-editor .emdash-image--align-full {
		width: 100%;
	}
	@media (max-width: 640px) {
		.emdash-inline-editor .emdash-image--align-left,
		.emdash-inline-editor .emdash-image--align-right {
			float: none;
			width: 100%;
			max-width: 100%;
			margin-inline: 0;
		}
	}
`;
