import { PluginRouteError } from "emdash";

export interface SubmissionFileInput {
	filename: string;
	contentType: string;
	bytes: ArrayBuffer;
}

const MAX_FILES = 5;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 125 * 1024 * 1024;

const signatures: Record<string, (bytes: Uint8Array) => boolean> = {
	"application/pdf": (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
	"image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
	"image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	"video/mp4": (b) =>
		b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
};

const extensions: Record<string, Set<string>> = {
	"application/pdf": new Set(["pdf"]),
	"image/jpeg": new Set(["jpg", "jpeg"]),
	"image/png": new Set(["png"]),
	"video/mp4": new Set(["mp4"]),
};

function startsWith(bytes: Uint8Array, expected: number[]): boolean {
	return expected.every((byte, index) => bytes[index] === byte);
}

export function validateSubmissionFiles(files: Record<string, SubmissionFileInput>): void {
	const entries = Object.values(files);
	if (entries.length > MAX_FILES) {
		throw PluginRouteError.badRequest("A submission may include at most five files");
	}

	let total = 0;
	for (const file of entries) {
		const contentType = file.contentType.split(";")[0]!.trim().toLowerCase();
		const extension = file.filename.split(".").pop()?.toLowerCase() ?? "";
		const bytes = new Uint8Array(file.bytes);

		if (file.bytes.byteLength > MAX_FILE_SIZE) {
			throw PluginRouteError.badRequest(`${file.filename} exceeds the 25 MB file limit`);
		}
		total += file.bytes.byteLength;
		if (total > MAX_TOTAL_SIZE) {
			throw PluginRouteError.badRequest("Attachments exceed the 125 MB submission limit");
		}
		if (!extensions[contentType]?.has(extension) || !signatures[contentType]?.(bytes)) {
			throw PluginRouteError.badRequest(`File signature does not match ${file.filename}`);
		}
	}
}
