/**
 * The empty state of the editor's media blocks: a dashed box to click, or to
 * drop a file on, while the block waits for its image or video. Inserting one
 * opens its picker; closing the picker leaves the box to fill later.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import type { Icon } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import * as React from "react";

import { cn } from "../../lib/utils";

export const isFileDrag = (event: { dataTransfer: DataTransfer | null }) =>
	Boolean(event.dataTransfer?.types.includes("Files"));

/** Whether an image or video node is empty, still waiting for its media. */
export function isEmptyMedia(attrs: Record<string, unknown>): boolean {
	return !attrs.mediaId && !attrs.src;
}

/** A `disableDropCursor` rule: files dropped on an empty media block replace it, so no insertion line is drawn. */
export function hideDropCursorOverEmpty(
	view: EditorView,
	pos: { inside: number },
	event: DragEvent,
): boolean {
	const node = view.state.doc.nodeAt(pos.inside);
	return isFileDrag(event) && node !== null && isEmptyMedia(node.attrs);
}

export interface MediaPickerStorage {
	openPickerOnMount: boolean;
}

const pickerStorage = (editor: Editor, name: string) =>
	(editor.storage as unknown as Record<string, MediaPickerStorage | undefined>)[name];

/** Opens the picker of the empty `name` block that the next insert adds, once it mounts. */
export function openPickerOnInsert(editor: Editor, name: string) {
	const storage = pickerStorage(editor, name);
	if (storage) storage.openPickerOnMount = true;
}

/**
 * Whether a node view mounting now is the block an insert just added, which is
 * the selected node; takes the request. Loading, undo and paste never make one.
 */
export function takePickerRequest(
	editor: Editor,
	name: string,
	getPos: () => number | undefined,
): boolean {
	const storage = pickerStorage(editor, name);
	const { selection } = editor.state;
	if (!storage?.openPickerOnMount) return false;
	if (!(selection instanceof NodeSelection) || selection.from !== getPos()) return false;
	storage.openPickerOnMount = false;
	return true;
}

/** Opens the picker of a node-selected empty media block, as clicking its placeholder does. */
export function chooseSelectedEmpty(editor: Editor, type: NodeType): boolean {
	const { selection } = editor.state;
	if (!(selection instanceof NodeSelection) || selection.node.type !== type) return false;
	if (!isEmptyMedia(selection.node.attrs)) return false;
	const dom = editor.view.nodeDOM(selection.from);
	const placeholder =
		dom instanceof HTMLElement ? dom.querySelector<HTMLElement>("[data-media-placeholder]") : null;
	placeholder?.click();
	return placeholder !== null;
}

/**
 * ProseMirror leaves keys on a node view's buttons and players to the browser,
 * whose own editing would change the text around the block: typing replaces it,
 * and Backspace joins the paragraphs on either side. This cancels that editing
 * from inside `ref`, except from the `exempt` text field. Input method text
 * can't be cancelled, so it gets no selection to go to.
 */
export function useNativeEditGuard(
	ref: React.RefObject<HTMLElement | null>,
	exempt?: React.RefObject<HTMLElement | null>,
) {
	React.useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const keepEditsOut = (event: InputEvent) => {
			if (event.target !== exempt?.current) event.preventDefault();
		};
		const keepCompositionOut = (event: CompositionEvent) => {
			if (event.target !== exempt?.current) {
				element.ownerDocument.getSelection()?.removeAllRanges();
			}
		};
		element.addEventListener("beforeinput", keepEditsOut);
		element.addEventListener("compositionstart", keepCompositionOut);
		return () => {
			element.removeEventListener("beforeinput", keepEditsOut);
			element.removeEventListener("compositionstart", keepCompositionOut);
		};
	}, [ref, exempt]);
}

export interface MediaPlaceholderProps {
	icon: Icon;
	/** What clicking does, such as "Upload or choose a video". */
	label: string;
	/** Shown instead in a read-only entry, such as "No video". */
	readOnlyLabel: string;
	editable: boolean;
	selected: boolean;
	dir: "ltr" | "rtl";
	onChoose: () => void;
	onRemove: () => void;
	/** Extra attributes for the button, such as a node view's own keyboard stop. */
	buttonAttributes?: Record<`data-${string}`, string>;
}

export function MediaPlaceholder({
	icon: MediaIcon,
	label,
	readOnlyLabel,
	editable,
	selected,
	dir,
	onChoose,
	onRemove,
	buttonAttributes,
}: MediaPlaceholderProps) {
	const { t } = useLingui();
	const ref = React.useRef<HTMLDivElement>(null);
	const [dropping, setDropping] = React.useState(false);
	const dragDepth = React.useRef(0);
	useNativeEditGuard(ref);

	// ProseMirror would take a press on the button's label and move focus to the editor,
	// so the button keeps the press, and focus, for its own keys.
	React.useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const keepPress = (event: MouseEvent) => event.stopPropagation();
		element.addEventListener("mousedown", keepPress);
		return () => element.removeEventListener("mousedown", keepPress);
	}, []);

	// Only the highlight: ProseMirror takes the drop, and the upload extension
	// puts the dropped files in this block's place.
	const dropHighlight = {
		onDragEnter: (event: React.DragEvent) => {
			if (!isFileDrag(event)) return;
			dragDepth.current += 1;
			setDropping(true);
		},
		onDragLeave: (event: React.DragEvent) => {
			if (!isFileDrag(event)) return;
			dragDepth.current = Math.max(0, dragDepth.current - 1);
			if (dragDepth.current === 0) setDropping(false);
		},
		onDrop: () => {
			dragDepth.current = 0;
			setDropping(false);
		},
	};

	// ProseMirror ignores keydown on the placeholder, so it removes the block itself rather
	// than relying on the browser's editing.
	const removeOnDeleteKey = (event: React.KeyboardEvent<HTMLElement>) => {
		if (event.key !== "Backspace" && event.key !== "Delete") return;
		if (event.nativeEvent.isComposing) return;
		event.preventDefault();
		onRemove();
	};

	return (
		<div
			ref={ref}
			dir={dir}
			className={cn(
				"rounded-lg border border-dashed border-kumo-line bg-kumo-control motion-safe:transition-colors",
				// Important, because the admin's unlayered `*` border color beats utilities.
				dropping && "border-kumo-brand! bg-kumo-tint",
				selected &&
					"group-focus-within/editor:ring-2 ring-kumo-brand ring-offset-2 ring-offset-kumo-base",
			)}
			{...(editable ? dropHighlight : {})}
		>
			{editable ? (
				<Button
					type="button"
					variant="ghost"
					tabIndex={-1}
					data-media-placeholder=""
					{...buttonAttributes}
					className="h-auto w-full justify-start gap-3 rounded-[7px] px-4 py-3 text-start text-sm font-normal text-kumo-subtle"
					onClick={onChoose}
					onKeyDown={removeOnDeleteKey}
				>
					<MediaIcon className="size-5 shrink-0" aria-hidden="true" />
					{dropping ? t`Drop to upload` : label}
				</Button>
			) : (
				<p className="m-0! flex items-center gap-3 px-4 py-3 text-sm text-kumo-subtle">
					<MediaIcon className="size-5 shrink-0" aria-hidden="true" />
					{readOnlyLabel}
				</p>
			)}
		</div>
	);
}
