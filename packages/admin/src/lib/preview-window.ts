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
	const preview = window.open(url, `emdash-preview-${collection}-${id}`);
	if (!preview) return;
	preview.opener = null;
	preview.focus();
}
