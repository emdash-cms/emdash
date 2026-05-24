export const EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip",
	".csv": "text/csv",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".txt": "text/plain",
	".rtf": "application/rtf",
	".vtt": "text/vtt",
	".srt": "application/x-subrip",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export const VALID_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_+\-.]*\/[a-z0-9!#$&^_+\-.]*$/i;

/** Mirror of core matchesMimeAllowlist — kept in sync for client-side pre-validation. */
export function matchesMimeAllowlist(mime: string, allowList: readonly string[]): boolean {
	const normalized = mime.split(";")[0]!.trim().toLowerCase();
	for (const entry of allowList) {
		if (!entry || !entry.includes("/")) continue;
		const normalizedEntry = entry.split(";")[0]!.trim().toLowerCase();
		if (normalizedEntry.endsWith("/")) {
			if (normalized.startsWith(normalizedEntry)) return true;
		} else if (normalized === normalizedEntry) {
			return true;
		}
	}
	return false;
}

/** Try to resolve a MIME type from a URL's file extension. Returns null on failure. */
export function mimeFromUrl(url: URL): string | null {
	const lastSegment = url.pathname.split("/").pop() ?? "";
	const dotIdx = lastSegment.lastIndexOf(".");
	if (dotIdx === -1) return null;
	const ext = lastSegment.slice(dotIdx).toLowerCase();
	return EXTENSION_TO_MIME[ext] ?? null;
}
