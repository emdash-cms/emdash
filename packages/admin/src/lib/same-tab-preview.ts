/**
 * Same-tab preview. The editor asks `openPreviewWindow` to show an entry;
 * when the shell has registered a host, that opens an overlay instead of a
 * second browser tab.
 */

type OpenPreview = (url: string) => void;

let openPreview: OpenPreview | null = null;

export function registerSameTabPreview(open: OpenPreview): () => void {
	openPreview = open;
	return () => {
		if (openPreview === open) openPreview = null;
	};
}

export function hasSameTabPreview(): boolean {
	return openPreview !== null;
}

export function openSameTabPreview(url: string): boolean {
	if (!openPreview || !url) return false;
	openPreview(url);
	return true;
}
