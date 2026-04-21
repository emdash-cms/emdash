import type { MediaItem, MediaProviderItem } from "./api/media.js";

export function providerItemToMediaItem(
	providerId: string,
	item: MediaProviderItem,
): MediaItem & { provider: string; meta?: Record<string, unknown> } {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		url: item.previewUrl || "",
		size: item.size || 0,
		width: item.width,
		height: item.height,
		alt: item.alt,
		createdAt: new Date().toISOString(),
		provider: providerId,
		meta: item.meta,
	} as MediaItem & { provider: string; meta?: Record<string, unknown> };
}

export function getFileIcon(mimeType: string): string {
	if (mimeType.startsWith("video/")) return "🎬";
	if (mimeType.startsWith("audio/")) return "🎵";
	if (mimeType.includes("pdf")) return "📄";
	if (mimeType.includes("document") || mimeType.includes("word")) return "📝";
	if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "📊";
	return "📁";
}

export function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
