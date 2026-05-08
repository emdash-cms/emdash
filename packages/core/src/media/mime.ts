export function normalizeMime(mime: string): string {
	return mime.split(";")[0]!.trim().toLowerCase();
}

export function matchesMimeAllowlist(mime: string, allowList: readonly string[]): boolean {
	const normalized = normalizeMime(mime);
	for (const entry of allowList) {
		if (!entry || !entry.includes("/")) continue;
		const normalizedEntry = normalizeMime(entry);
		if (normalizedEntry.endsWith("/")) {
			if (normalized.startsWith(normalizedEntry)) return true;
		} else if (normalized === normalizedEntry) {
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

const VALID_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_+\-.]*\/[a-z0-9!#$&^_+\-.]*$/i;

export function expandExtensionShorthand(entry: string): string | null {
	const trimmed = entry.trim();
	if (!trimmed) return null;
	if (trimmed.includes("/")) return VALID_MIME_RE.test(trimmed) ? trimmed : null;
	if (trimmed.startsWith(".")) {
		return EXTENSION_TO_MIME[trimmed.toLowerCase()] ?? null;
	}
	return null;
}

/**
 * Extract the `allowedMimeTypes` list from a `_emdash_fields.validation` row
 * (raw JSON string). Returns null when the value is missing, malformed, or the
 * list is empty — callers treat that as "no field-specific constraint".
 */
export function parseAllowedMimeTypes(rawValidation: string | null | undefined): string[] | null {
	if (!rawValidation) return null;
	try {
		const parsed: unknown = JSON.parse(rawValidation);
		if (typeof parsed !== "object" || parsed === null) return null;
		const list = (parsed as { allowedMimeTypes?: unknown }).allowedMimeTypes;
		if (!Array.isArray(list) || list.length === 0) return null;
		return list.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return null;
	}
}
