import { hasSameTabPreview, openSameTabPreview } from "./same-tab-preview.js";

declare global {
	interface Window {
		/**
		 * Polemos: when set, preview stays in this tab. Returning true means the
		 * caller handled the URL. Kept so a host page can still intercept.
		 */
		__polemosPreview?: (url: string, collection: string, id: string) => boolean;
	}
}

/**
 * Open an entry's preview in a tab named for that entry, so previewing the
 * same entry again reloads its tab instead of opening another one.
 *
 * Polemos shows that preview in the admin tab when a host is registered, or
 * when `window.__polemosPreview` handles it.
 *
 * A named target can't be combined with the `noopener` feature: browsers
 * ignore the name and open a new tab every time. The opener reference is
 * cleared on the returned window instead, which keeps the preview page from
 * reaching back into the admin.
 */
export function openPreviewWindow(url: string, collection: string, id: string): void {
	if (typeof window.__polemosPreview === "function" && window.__polemosPreview(url, collection, id) === true) {
		return;
	}
	if (openSameTabPreview(url)) return;
	const preview = window.open(url, previewWindowName(collection, id));
	if (!preview) return;
	preview.opener = null;
	preview.focus();
}

/**
 * Opens the entry's preview tab, or finds it if it's open, without loading anything yet: a tab
 * opened later than the click that asked for it would be blocked as a popup. `created` is false
 * for a tab that was already open, including one showing another site, whose location can't be
 * read.
 */
export function openBlankPreviewWindow(
	collection: string,
	id: string,
): { preview: Window; created: boolean } | null {
	if (typeof window.__polemosPreview === "function") {
		return { created: true, preview: polemosHookPreview(collection, id) };
	}
	if (hasSameTabPreview()) {
		return { created: true, preview: sameTabPreviewWindow() };
	}
	const preview = window.open("", previewWindowName(collection, id));
	if (!preview) return null;
	let created: boolean;
	try {
		created = preview.location.href === "about:blank";
	} catch {
		created = false;
	}
	if (created) preview.opener = null;
	return { preview, created };
}

function previewWindowName(collection: string, id: string): string {
	return `emdash-preview-${collection}-${id}`;
}

/** A window stand-in whose location setter stays in the admin tab. */
function sameTabPreviewWindow(): Window {
	let href = "about:blank";
	return {
		close() {},
		focus() {},
		get location() {
			return {
				get href() {
					return href;
				},
				set href(value: string) {
					href = value;
					openSameTabPreview(value);
				},
			};
		},
	} as unknown as Window;
}

function polemosHookPreview(collection: string, id: string): Window {
	return {
		close() {},
		focus() {},
		get location() {
			return {
				get href() {
					return "about:blank";
				},
				set href(value: string) {
					window.__polemosPreview?.(value, collection, id);
				},
			};
		},
	} as unknown as Window;
}
