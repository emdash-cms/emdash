const HEIC_MIME_TYPES = new Set([
	"image/heic",
	"image/heif",
	"image/heic-sequence",
	"image/heif-sequence",
]);
const HEIC_FILENAME_PATTERN = /\.(?:heic|heif|heics|heifs|hif)$/i;

export type HeicConverter = (file: File) => Promise<Blob>;

async function convertHeicToJpeg(file: File): Promise<Blob> {
	const { heicTo } = await import("heic-to/csp");
	return heicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
}

function isHeicFile(file: File): boolean {
	return HEIC_MIME_TYPES.has(file.type.toLowerCase()) || HEIC_FILENAME_PATTERN.test(file.name);
}

function jpegFilename(filename: string): string {
	const stem = filename.replace(HEIC_FILENAME_PATTERN, "");
	return `${stem || "image"}.jpg`;
}

export async function prepareMediaUploadFile(
	file: File,
	convert: HeicConverter = convertHeicToJpeg,
): Promise<File> {
	if (!isHeicFile(file)) return file;

	const jpeg = await convert(file);
	return new File([jpeg], jpegFilename(file.name), {
		type: "image/jpeg",
		lastModified: file.lastModified,
	});
}
