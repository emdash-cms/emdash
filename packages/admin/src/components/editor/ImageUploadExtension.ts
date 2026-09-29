import { buttonVariants, Loader } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createUploadPreviewUrl } from "../../lib/media-utils.js";
import { matchesMimeAllowlist } from "../../lib/mime-utils.js";
import { getMutationError } from "../DialogError.js";

export interface ImageUploadOptions {
	/** Uploads a file and resolves to the attributes of the image node to insert. */
	upload: ((file: File, signal: AbortSignal) => Promise<Record<string, unknown>>) | null;
}

interface Placeholder {
	id: number;
	pos: number;
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
		placeholder.previewUrl ? "w-fit min-w-72" : "w-full"
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
		label.textContent = i18n._(msg`Uploading image…`);
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
		return { upload: null };
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
		const upload = this.options.upload;
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

		const insertImage = (view: EditorView, id: number, attrs: Record<string, unknown>) => {
			if (view.isDestroyed) return;
			if (!view.editable) {
				dispatchMeta(view, {
					fail: id,
					error: i18n._(msg`The image is in the Media Library, but this entry is now read-only.`),
				});
				return;
			}
			const placeholder = imageUploadKey.getState(view.state)?.find((item) => item.id === id);
			const imageType = view.state.schema.nodes.image;
			const tr = view.state.tr.setMeta(imageUploadKey, { remove: id } satisfies PlaceholderMeta);
			if (placeholder && imageType) {
				tr.insert(placeholder.pos, imageType.create(attrs));
			}
			view.dispatch(tr);
			releasePreview(id);
		};

		const start = (view: EditorView, files: File[], dropPos: number) => {
			const pos = blockBoundary(view.state.doc, dropPos);
			const images = files.filter((file) => matchesMimeAllowlist(file.type, IMAGE_TYPES));
			const uploads = images.map((file) => {
				const id = ++nextId;
				const previewUrl = createUploadPreviewUrl(file);
				if (previewUrl) previewUrls.set(id, previewUrl);
				return { file, placeholder: { id, pos, previewUrl } };
			});
			const placeholders: Placeholder[] = uploads.map(({ placeholder }) => placeholder);
			if (images.length < files.length) {
				placeholders.push({
					id: ++nextId,
					pos,
					error: i18n._(msg`Only image files can be uploaded here.`),
				});
			}
			dispatchMeta(view, { add: placeholders });

			void (async () => {
				for (const { file, placeholder } of uploads) {
					try {
						insertImage(view, placeholder.id, await upload(file, controller.signal));
					} catch (error) {
						if (controller.signal.aborted) return;
						dispatchMeta(view, {
							fail: placeholder.id,
							error: getMutationError(error) ?? i18n._(msg`Image upload failed. Try again.`),
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
						start(view, files, coords.pos);
						return true;
					},
					handlePaste(view, event) {
						const data = event.clipboardData;
						const hasImage = [...(data?.files ?? [])].some((file) =>
							matchesMimeAllowlist(file.type, IMAGE_TYPES),
						);
						if (!data || !hasImage) return false;
						// Word, Excel and similar apps put a picture of the selection beside the real content.
						const html = data.getData("text/html");
						if (html && hasText(html)) return false;
						event.preventDefault();
						start(view, [...data.files], view.state.selection.from);
						return true;
					},
				},
			}),
		];
	},
});
