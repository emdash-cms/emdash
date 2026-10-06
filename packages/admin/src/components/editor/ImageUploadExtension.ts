import { buttonVariants, Loader } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createUploadPreviewUrl } from "../../lib/media-utils.js";
import { matchesMimeAllowlist } from "../../lib/mime-utils.js";
import { getMutationError } from "../DialogError.js";
import { isEmptyVideo } from "./VideoNode.js";

export interface ImageUploadOptions {
	/** Uploads a file and resolves to the attributes of the image or video node to insert. */
	upload: ((file: File, signal: AbortSignal) => Promise<Record<string, unknown>>) | null;
	/** Whether video files become video blocks, read when files are dropped or pasted. */
	acceptsVideo: () => boolean;
}

type MediaKind = "image" | "video";

interface Placeholder {
	id: number;
	pos: number;
	kind?: MediaKind;
	previewUrl?: string;
	error?: string;
}

type PlaceholderMeta =
	| { add: Placeholder[] }
	| { fail: number; error: string }
	| { remove: number };

type DismissHandler = (view: EditorView, id: number) => void;

const imageUploadKey = new PluginKey<Placeholder[]>("imageUpload");

const IMAGE_TYPES = ["image/"];
const VIDEO_TYPES = ["video/"];

const DROP_EVENTS = new Set(["dragenter", "dragover", "drop"]);

function placeholderWidget(placeholder: Placeholder, onDismiss: DismissHandler) {
	return Decoration.widget(
		placeholder.pos,
		(view) => renderPlaceholder(placeholder, () => onDismiss(view, placeholder.id)),
		{
			// Later files render after earlier ones sharing a position.
			side: placeholder.id,
			key: `image-upload-${placeholder.id}-${placeholder.error ? "error" : "uploading"}`,
			ignoreSelection: true,
			// Drops reach the editor, so a file dropped on a placeholder isn't opened by the browser.
			stopEvent: (event) => !DROP_EVENTS.has(event.type),
			destroy: (node) => unmountSpinner(node),
		},
	);
}

const spinnerRoots = new WeakMap<globalThis.Node, Root>();

function renderSpinner(placeholder: HTMLElement) {
	const container = document.createElement("span");
	// The text beside the spinner is the status announcement.
	container.setAttribute("aria-hidden", "true");
	container.className = "flex shrink-0 text-kumo-subtle";
	const root = createRoot(container);
	root.render(createElement(Loader, { size: "sm" }));
	spinnerRoots.set(placeholder, root);
	return container;
}

function unmountSpinner(placeholder: globalThis.Node) {
	const root = spinnerRoots.get(placeholder);
	if (!root) return;
	spinnerRoots.delete(placeholder);
	// ProseMirror can destroy widgets while React is rendering the editor.
	queueMicrotask(() => root.unmount());
}

function renderPlaceholder(placeholder: Placeholder, onDismiss: () => void) {
	const root = document.createElement("div");
	root.dataset.imageUploadPlaceholder = "";
	root.contentEditable = "false";
	root.className = `relative my-4 flex min-h-24 max-w-full overflow-hidden rounded-md bg-kumo-tint ${
		placeholder.previewUrl
			? "w-fit min-w-72"
			: placeholder.kind === "video"
				? "aspect-video w-full"
				: "w-full"
	}`;

	if (placeholder.previewUrl) {
		const preview = document.createElement("img");
		preview.src = placeholder.previewUrl;
		preview.alt = "";
		preview.draggable = false;
		preview.className = "m-0! block max-h-96 max-w-full opacity-50";
		root.append(preview);
	}

	const status = document.createElement("div");
	// The editor content sets its own direction from the text; this pill is admin chrome.
	status.dir = document.documentElement.dir || "ltr";
	status.className =
		"absolute start-3 top-3 flex max-w-[calc(100%-1.5rem)] items-center gap-3 rounded-md bg-kumo-base px-3 py-2 text-sm shadow";
	if (placeholder.error) {
		const message = document.createElement("p");
		message.setAttribute("role", "alert");
		message.className = "m-0! text-kumo-danger";
		message.textContent = placeholder.error;
		const dismiss = document.createElement("button");
		dismiss.type = "button";
		dismiss.className = buttonVariants({ variant: "secondary", size: "sm" });
		dismiss.textContent = i18n._(msg`Dismiss`);
		dismiss.addEventListener("click", onDismiss);
		status.append(message, dismiss);
	} else {
		const label = document.createElement("span");
		label.setAttribute("role", "status");
		label.className = "text-kumo-subtle";
		label.textContent =
			placeholder.kind === "video" ? i18n._(msg`Uploading video…`) : i18n._(msg`Uploading image…`);
		status.append(renderSpinner(root), label);
	}
	root.append(status);
	return root;
}

// Portable Text drops images nested in lists or quotes, so they go between top-level blocks.
function blockBoundary(doc: Node, pos: number) {
	const $pos = doc.resolve(pos);
	if ($pos.depth === 0) return pos;
	return pos <= ($pos.start(1) + $pos.end(1)) / 2 ? $pos.before(1) : $pos.after(1);
}

/** The range of the empty video block at `pos`, which files dropped or pasted on it replace. */
function emptyVideoAt(doc: Node, pos: number) {
	const node = pos >= 0 ? doc.nodeAt(pos) : null;
	if (node?.type.name !== "videoBlock" || !isEmptyVideo(node.attrs)) return undefined;
	return { from: pos, to: pos + node.nodeSize };
}

function hasText(html: string) {
	return Boolean(new DOMParser().parseFromString(html, "text/html").body.textContent?.trim());
}

interface ImageUploadStorage {
	controller: AbortController;
	previewUrls: Map<number, string>;
}

export const ImageUploadExtension = Extension.create<ImageUploadOptions, ImageUploadStorage>({
	name: "imageUpload",

	addOptions() {
		return { upload: null, acceptsVideo: () => false };
	},

	addStorage() {
		return { controller: new AbortController(), previewUrls: new Map() };
	},

	// Uploads belong to the editor, not the plugin view: ProseMirror rebuilds plugin views
	// whenever any plugin is registered, which would otherwise cancel them mid-flight.
	onDestroy() {
		this.storage.controller.abort();
		for (const url of this.storage.previewUrls.values()) URL.revokeObjectURL(url);
		this.storage.previewUrls.clear();
	},

	addProseMirrorPlugins() {
		const { upload, acceptsVideo } = this.options;
		if (!upload) return [];

		const { controller, previewUrls } = this.storage;
		let nextId = 0;

		const releasePreview = (id: number) => {
			const url = previewUrls.get(id);
			if (url) URL.revokeObjectURL(url);
			previewUrls.delete(id);
		};

		const dispatchMeta = (view: EditorView, meta: PlaceholderMeta) => {
			if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(imageUploadKey, meta));
		};

		const dismiss: DismissHandler = (view, id) => {
			releasePreview(id);
			dispatchMeta(view, { remove: id });
			view.focus();
		};

		const takesVideo = (view: EditorView) =>
			Boolean(view.state.schema.nodes.videoBlock) && acceptsVideo();

		const kindOf = (view: EditorView, file: File): MediaKind | null => {
			if (matchesMimeAllowlist(file.type, IMAGE_TYPES)) return "image";
			if (matchesMimeAllowlist(file.type, VIDEO_TYPES) && takesVideo(view)) return "video";
			return null;
		};

		const insertMedia = (
			view: EditorView,
			id: number,
			kind: MediaKind,
			attrs: Record<string, unknown>,
		) => {
			if (view.isDestroyed) return;
			if (!view.editable) {
				dispatchMeta(view, {
					fail: id,
					error:
						kind === "video"
							? i18n._(msg`The video is in the Media Library, but this entry is now read-only.`)
							: i18n._(msg`The image is in the Media Library, but this entry is now read-only.`),
				});
				return;
			}
			const placeholder = imageUploadKey.getState(view.state)?.find((item) => item.id === id);
			const nodeType = view.state.schema.nodes[kind === "video" ? "videoBlock" : "image"];
			const tr = view.state.tr.setMeta(imageUploadKey, { remove: id } satisfies PlaceholderMeta);
			if (placeholder && nodeType) {
				tr.insert(placeholder.pos, nodeType.create(attrs));
			}
			view.dispatch(tr);
			releasePreview(id);
		};

		const start = (
			view: EditorView,
			files: File[],
			dropPos: number,
			emptyVideo?: { from: number; to: number },
		) => {
			const media = files.flatMap((file) => {
				const kind = kindOf(view, file);
				return kind ? [{ file, kind }] : [];
			});
			const tr = view.state.tr;
			let pos: number;
			if (emptyVideo && media.length > 0) {
				tr.delete(emptyVideo.from, emptyVideo.to);
				pos = emptyVideo.from;
			} else {
				pos = blockBoundary(view.state.doc, dropPos);
			}
			const uploads = media.map(({ file, kind }) => {
				const id = ++nextId;
				const previewUrl = kind === "image" ? createUploadPreviewUrl(file) : undefined;
				if (previewUrl) previewUrls.set(id, previewUrl);
				return { file, kind, placeholder: { id, pos, kind, previewUrl } };
			});
			const placeholders: Placeholder[] = uploads.map(({ placeholder }) => placeholder);
			if (uploads.length < files.length) {
				placeholders.push({
					id: ++nextId,
					pos,
					error: takesVideo(view)
						? i18n._(msg`Only images and videos can be uploaded here.`)
						: i18n._(msg`Only image files can be uploaded here.`),
				});
			}
			view.dispatch(tr.setMeta(imageUploadKey, { add: placeholders } satisfies PlaceholderMeta));

			void (async () => {
				for (const { file, kind, placeholder } of uploads) {
					try {
						insertMedia(view, placeholder.id, kind, await upload(file, controller.signal));
					} catch (error) {
						if (controller.signal.aborted) return;
						dispatchMeta(view, {
							fail: placeholder.id,
							error:
								getMutationError(error) ??
								(kind === "video"
									? i18n._(msg`Video upload failed. Try again.`)
									: i18n._(msg`Image upload failed. Try again.`)),
						});
					}
				}
			})();
		};

		return [
			new Plugin<Placeholder[]>({
				key: imageUploadKey,
				state: {
					init: () => [],
					apply(tr, placeholders) {
						// Mapped positions are never dropped, so edits beside a placeholder can't discard its upload.
						const next = tr.docChanged
							? placeholders.map((item) => ({
									...item,
									pos: blockBoundary(tr.doc, tr.mapping.map(item.pos, 1)),
								}))
							: placeholders;
						// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only this plugin sets its meta
						const meta = tr.getMeta(imageUploadKey) as PlaceholderMeta | undefined;
						if (!meta) return next;
						if ("add" in meta) return [...next, ...meta.add];
						if ("fail" in meta) {
							return next.map((item) =>
								item.id === meta.fail ? { ...item, error: meta.error } : item,
							);
						}
						return next.filter((item) => item.id !== meta.remove);
					},
				},
				props: {
					decorations(state) {
						const placeholders = imageUploadKey.getState(state);
						if (!placeholders?.length) return DecorationSet.empty;
						return DecorationSet.create(
							state.doc,
							placeholders.map((item) => placeholderWidget(item, dismiss)),
						);
					},
					handleDrop(view, event, _slice, moved) {
						const files = [...(event.dataTransfer?.files ?? [])];
						if (moved || files.length === 0) return false;
						const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
						if (!coords) return false;
						event.preventDefault();
						start(view, files, coords.pos, emptyVideoAt(view.state.doc, coords.inside));
						return true;
					},
					handlePaste(view, event) {
						const data = event.clipboardData;
						const hasMedia = [...(data?.files ?? [])].some((file) => kindOf(view, file) !== null);
						if (!data || !hasMedia) return false;
						// Word, Excel and similar apps put a picture of the selection beside the real content.
						const html = data.getData("text/html");
						if (html && hasText(html)) return false;
						event.preventDefault();
						const { selection } = view.state;
						const emptyVideo =
							selection instanceof NodeSelection
								? emptyVideoAt(view.state.doc, selection.from)
								: undefined;
						start(view, [...data.files], selection.from, emptyVideo);
						return true;
					},
				},
			}),
		];
	},
});
