/**
 * Open an entry's preview in a tab named for that entry, so previewing the
 * same entry again reloads its tab instead of opening another one.
 *
 * A named target can't be combined with the `noopener` feature: browsers
 * ignore the name and open a new tab every time. The opener reference is
 * cleared on the returned window instead, which keeps the preview page from
 * reaching back into the admin.
 */
export function openPreviewWindow(url: string, collection: string, id: string): void {
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
