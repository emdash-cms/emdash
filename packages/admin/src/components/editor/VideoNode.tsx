/**
 * Video block node for the admin editor.
 *
 * A Media Library video in a rounded player as wide as the text, with a
 * caption under it and Replace and Delete in a pill over its corner.
 * Round-trips through Portable Text as
 * `{ _type: "video", _key, asset?: { _ref, url?, provider? }, caption?, width?, height? }`,
 * without `asset` when it has no video.
 * Keep the shape in sync with core's `content/converters/video.ts`.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowsClockwise, Trash, VideoCameraSlash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import { fetchMediaItem, type MediaItem } from "../../lib/api/media.js";
import {
	canonicalMediaProviderId,
	getMediaPreviewUrl,
	localMediaFileUrl,
} from "../../lib/media-utils.js";
import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import { MediaPickerModal } from "../MediaPickerModal";

type FieldCheck = (value: unknown) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isDimension = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1;

const hasOnly = (record: Record<string, unknown>, fields: Map<string, FieldCheck>) =>
	Object.entries(record).every(
		([key, value]) => value === undefined || (fields.get(key)?.(value) ?? false),
	);

const ASSET_FIELDS = new Map<string, FieldCheck>([
	["_ref", isString],
	["url", isString],
	["provider", isString],
]);

const isAsset = (value: unknown): value is Record<string, unknown> =>
	isRecord(value) && isString(value._ref) && hasOnly(value, ASSET_FIELDS);

const VIDEO_FIELDS = new Map<string, FieldCheck>([
	["_type", () => true],
	["_key", () => true],
	["asset", isAsset],
	["caption", isString],
	["width", isDimension],
	["height", isDimension],
]);

/**
 * Whether a block is the editor's own video block. A `video` block with other
 * fields, or values of other types, belongs to a plugin.
 */
export function isVideoBlock(block: unknown): boolean {
	return isRecord(block) && block._type === "video" && hasOnly(block, VIDEO_FIELDS);
}

/** A video block's node attributes. */
export function videoNodeAttrs(block: unknown): Record<string, unknown> {
	const record = isRecord(block) ? block : {};
	const asset = isRecord(record.asset) ? record.asset : {};
	return {
		src: isString(asset.url) ? asset.url : "",
		mediaId: isString(asset._ref) ? asset._ref : null,
		provider: isString(asset.provider) ? asset.provider : null,
		caption: isString(record.caption) ? record.caption : "",
		width: isDimension(record.width) ? record.width : null,
		height: isDimension(record.height) ? record.height : null,
	};
}

/** A video node's Portable Text fields, written only when set. */
export function videoBlockFields(attrs: Record<string, unknown>): Record<string, unknown> {
	const { src, mediaId, provider, caption, width, height } = attrs;
	const asset: Record<string, string> = { _ref: isString(mediaId) ? mediaId : "" };
	if (isString(src) && src) asset.url = src;
	if (isString(provider) && provider && provider !== "local") asset.provider = provider;
	// An empty block has no media id, file or provider.
	const empty = !isString(mediaId) && !asset.url && !asset.provider;
	return {
		...(empty ? {} : { asset }),
		...(isString(caption) && caption ? { caption } : {}),
		...(isDimension(width) ? { width } : {}),
		...(isDimension(height) ? { height } : {}),
	};
}

/** Node attributes for a picked or uploaded Media Library video. */
export function mediaItemToVideoAttrs(item: MediaItem) {
	return {
		src: item.url || (item.storageKey ? localMediaFileUrl(item.storageKey) : ""),
		mediaId: item.id,
		provider: canonicalMediaProviderId(item.provider),
		width: isDimension(item.width) ? item.width : null,
		height: isDimension(item.height) ? item.height : null,
	};
}

const STOP = "[data-video-stop]";

/** Focus the node-selected video's first control, for keyboard users. */
function focusSelectedVideo(editor: Editor, type: NodeType): boolean {
	const { selection } = editor.state;
	if (!(selection instanceof NodeSelection) || selection.node.type !== type) return false;
	const dom = editor.view.nodeDOM(selection.from);
	const first = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(STOP) : null;
	first?.focus();
	return first !== null && document.activeElement === first;
}

/**
 * Drags and drops go to ProseMirror, so dropped files reach the upload
 * extension and the block can be moved from the gutter handle. The player,
 * caption and buttons own their other events; a press elsewhere on the
 * figure selects the block.
 */
function stopEvent({ event }: { event: Event }): boolean {
	if (event.type.startsWith("drag") || event.type === "drop") return false;
	const target = event.target instanceof Element ? event.target : null;
	return Boolean(target?.closest("video, textarea, button"));
}

/** Only keys from the figure's own elements count, not portals React bubbles through it. */
function ownsKey(event: React.KeyboardEvent<HTMLElement>): boolean {
	return (
		event.target instanceof Element &&
		event.currentTarget.contains(event.target) &&
		!event.nativeEvent.isComposing
	);
}

function VideoNodeView({
	node,
	editor,
	getPos,
	selected,
	updateAttributes,
	deleteNode,
}: NodeViewProps) {
	const { t, i18n } = useLingui();
	// The editor reads its direction from the text, so admin chrome sets its own.
	const chromeDir = getLocaleDir(i18n.locale);
	const editable = editor.isEditable;
	const attrs = node.attrs;
	const storedSrc = isString(attrs.src) ? attrs.src : "";
	const mediaId =
		isString(attrs.mediaId) && attrs.mediaId && canonicalMediaProviderId(attrs.provider) === "local"
			? attrs.mediaId
			: null;
	const { data: currentMedia } = useQuery({
		queryKey: ["media", mediaId],
		queryFn: ({ signal }) => fetchMediaItem(mediaId!, { signal }),
		enabled: mediaId !== null,
	});
	// Without a stored file URL the site can't play the video either, so the
	// editor doesn't preview one.
	const src = getMediaPreviewUrl(currentMedia?.url || storedSrc, currentMedia?.contentHash);
	const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
	const failed = !src || failedSrc === src;
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const captionRef = React.useRef<HTMLTextAreaElement>(null);
	const caption = isString(attrs.caption) ? attrs.caption : "";
	const width = isDimension(attrs.width) ? attrs.width : undefined;
	const height = isDimension(attrs.height) ? attrs.height : undefined;
	const figureRef = React.useRef<HTMLElement>(null);

	// ProseMirror leaves keys on the player and buttons to the browser, whose own editing
	// would change the text around the block: typing replaces it, and Backspace joins the
	// paragraphs on either side. Input method text can't be cancelled, so it gets no
	// selection to go to.
	React.useEffect(() => {
		const figure = figureRef.current;
		if (!figure) return;
		const keepEditsOut = (event: InputEvent) => {
			if (event.target !== captionRef.current) event.preventDefault();
		};
		const keepCompositionOut = (event: CompositionEvent) => {
			if (event.target !== captionRef.current) {
				figure.ownerDocument.getSelection()?.removeAllRanges();
			}
		};
		figure.addEventListener("beforeinput", keepEditsOut);
		figure.addEventListener("compositionstart", keepCompositionOut);
		return () => {
			figure.removeEventListener("beforeinput", keepEditsOut);
			figure.removeEventListener("compositionstart", keepCompositionOut);
		};
	}, []);

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
	}, [editable]);

	const selectBlock = (focus: boolean) => {
		const position = getPos();
		if (typeof position !== "number") return;
		editor.commands.setNodeSelection(position);
		if (focus) editor.view.focus();
	};

	// Capture, so a button's open tooltip can't stop Escape first.
	const handleEscape = (event: React.KeyboardEvent<HTMLElement>) => {
		if (event.key !== "Escape" || !ownsKey(event)) return;
		event.preventDefault();
		selectBlock(true);
	};

	// The player, caption and buttons stay out of the page's Tab order, so a
	// post's videos add no stops to it; Tab moves between them here instead.
	const handleTab = (event: React.KeyboardEvent<HTMLElement>) => {
		if (event.key !== "Tab" || event.altKey || event.metaKey || event.ctrlKey) return;
		if (!ownsKey(event)) return;
		const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(STOP)];
		const index = stops.indexOf(event.target as HTMLElement);
		if (index === -1) return;
		const next = stops[event.shiftKey ? index - 1 : index + 1];
		if (next) {
			event.preventDefault();
			next.focus();
		} else if (event.shiftKey) {
			event.preventDefault();
			selectBlock(true);
		}
	};

	const handleCaptionKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		const position = getPos();
		if (typeof position !== "number") return;
		const after = position + node.nodeSize;
		editor
			.chain()
			.insertContentAt(after, { type: "paragraph" })
			.focus(after + 1)
			.run();
	};

	const removeBlock = () => {
		if (!editor.isEditable) return;
		editor.view.focus();
		deleteNode();
	};

	// Selected, the pill stays visible while the picker is open, so the
	// picker can hand focus back to Replace when it closes.
	const openPicker = () => {
		selectBlock(false);
		setPickerOpen(true);
	};

	const pillButtonClass = "h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11";

	return (
		<NodeViewWrapper className="relative my-4">
			<figure
				ref={figureRef}
				className="group/video relative my-0!"
				onKeyDownCapture={handleEscape}
				onKeyDown={handleTab}
			>
				<div
					className={cn(
						"relative overflow-hidden rounded-lg bg-kumo-recessed",
						// Shown only while focus is inside this editor, as with images.
						selected &&
							"group-focus-within/editor:ring-2 ring-kumo-brand ring-offset-2 ring-offset-kumo-base",
					)}
				>
					<video
						src={src || undefined}
						width={width}
						height={height}
						controls
						playsInline
						preload="metadata"
						draggable={false}
						tabIndex={-1}
						inert={failed || undefined}
						data-video-stop={failed ? undefined : ""}
						onError={() => setFailedSrc(src)}
						className="my-0! block h-auto max-h-[70vh] w-full"
					/>
					{failed && (
						<div
							dir={chromeDir}
							className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-kumo-tint text-sm text-kumo-subtle"
						>
							<VideoCameraSlash className="size-8" aria-hidden="true" />
							<p className="m-0!">{t`This video can't be played.`}</p>
						</div>
					)}
				</div>

				{editable ? (
					// Inline-size containment keeps the caption's placeholder text from widening the block.
					<figcaption className="mt-2 [contain:inline-size]">
						<textarea
							ref={captionRef}
							aria-label={t`Caption`}
							placeholder={t`Type caption for video (optional)`}
							rows={1}
							tabIndex={-1}
							dir="auto"
							value={caption}
							data-video-stop=""
							onChange={(event) => {
								if (editor.isEditable) updateAttributes({ caption: event.target.value });
							}}
							onFocus={() => selectBlock(false)}
							onKeyDown={handleCaptionKeyDown}
							className="block w-full resize-none field-sizing-content rounded-sm bg-transparent text-center text-sm text-kumo-subtle placeholder:text-kumo-placeholder focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50"
						/>
					</figcaption>
				) : (
					caption && (
						<figcaption className="mt-2 text-center text-sm text-kumo-subtle">{caption}</figcaption>
					)
				)}

				{editable && (
					<div
						role="group"
						aria-label={t`Video actions`}
						dir={chromeDir}
						className={cn(
							"absolute end-2 top-2 flex items-center gap-0.5 rounded-md border border-kumo-line bg-kumo-base p-0.5 shadow-sm",
							// Invisible, not only transparent, so a tap on the player can't hit a hidden button.
							"invisible opacity-0 motion-safe:transition-[opacity,visibility] motion-safe:duration-150",
							"group-hover/video:visible group-hover/video:opacity-100 group-focus-within/video:visible group-focus-within/video:opacity-100",
							selected && "visible opacity-100",
						)}
					>
						<Button
							type="button"
							variant="ghost"
							shape="square"
							size="sm"
							className={pillButtonClass}
							aria-label={t`Replace video`}
							title={t`Replace video`}
							tabIndex={-1}
							data-video-stop=""
							onClick={openPicker}
						>
							<ArrowsClockwise className="size-4" aria-hidden="true" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							shape="square"
							size="sm"
							className={pillButtonClass}
							aria-label={t`Delete video`}
							title={t`Delete video`}
							tabIndex={-1}
							data-video-stop=""
							onClick={removeBlock}
						>
							<Trash className="size-4" aria-hidden="true" />
						</Button>
					</div>
				)}
			</figure>

			{pickerOpen && (
				<MediaPickerModal
					open
					onOpenChange={setPickerOpen}
					onSelect={(item) => {
						if (editor.isEditable) updateAttributes(mediaItemToVideoAttrs(item));
						setPickerOpen(false);
					}}
					mimeTypeFilter="video/"
					mediaKind="video"
					localOnly
					title={t`Replace video`}
					confirmLabel={t`Replace`}
				/>
			)}
		</NodeViewWrapper>
	);
}

function textAttribute(name: string, attribute: string, fallback: string | null) {
	return {
		default: fallback,
		parseHTML: (element: HTMLElement) =>
			element.getAttribute(`data-video-${attribute}`) ?? fallback,
		renderHTML: (attributes: Record<string, unknown>) => {
			const value = attributes[name];
			return isString(value) && value ? { [`data-video-${attribute}`]: value } : {};
		},
	};
}

function numberAttribute(name: string) {
	return {
		default: null,
		parseHTML: (element: HTMLElement) => {
			const value = Number(element.getAttribute(`data-video-${name}`));
			return isDimension(value) ? value : null;
		},
		renderHTML: (attributes: Record<string, unknown>) =>
			isDimension(attributes[name]) ? { [`data-video-${name}`]: String(attributes[name]) } : {},
	};
}

/**
 * TipTap extension: video block.
 *
 * A top-level atom. The editor's global drag handle moves it, so dragging the
 * player's seek bar can't move the block.
 */
export const VideoExtension = Node.create({
	name: "videoBlock",
	group: "topBlock",
	atom: true,
	draggable: false,
	selectable: true,

	addAttributes() {
		return {
			src: textAttribute("src", "src", ""),
			mediaId: textAttribute("mediaId", "media-id", null),
			provider: textAttribute("provider", "provider", null),
			caption: textAttribute("caption", "caption", ""),
			width: numberAttribute("width"),
			height: numberAttribute("height"),
		};
	},

	parseHTML() {
		return [{ tag: "figure[data-video-block]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["figure", mergeAttributes(HTMLAttributes, { "data-video-block": "" })];
	},

	addNodeView() {
		return ReactNodeViewRenderer(VideoNodeView, { stopEvent });
	},

	addKeyboardShortcuts() {
		return {
			Tab: ({ editor }) => focusSelectedVideo(editor, this.type),
		};
	},
});
