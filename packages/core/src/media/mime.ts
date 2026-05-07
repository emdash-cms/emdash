export function matchesMimeAllowlist(mime: string, allowList: readonly string[]): boolean {
	for (const entry of allowList) {
		if (!entry || !entry.includes("/")) continue;
		if (entry.endsWith("/")) {
			if (mime.startsWith(entry)) return true;
		} else if (mime === entry) {
			return true;
		}
	}
	return false;
}

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

export function expandExtensionShorthand(entry: string): string | null {
	const trimmed = entry.trim();
	if (!trimmed) return null;
	if (trimmed.includes("/")) return trimmed;
	if (trimmed.startsWith(".")) {
		return EXTENSION_TO_MIME[trimmed.toLowerCase()] ?? null;
	}
	return null;
}
