export interface PixelCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CropAspectMode = "original" | "freeform" | "square" | "4:3" | "3:2" | "16:9";

const REPEATED_LEGACY_CROP_SUFFIX = /(?:-cropped){2,}$/i;

const CROPPABLE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function isSafeCrop(crop: PixelCrop): boolean {
	return (
		Number.isSafeInteger(crop.x) &&
		crop.x >= 0 &&
		Number.isSafeInteger(crop.y) &&
		crop.y >= 0 &&
		Number.isSafeInteger(crop.width) &&
		crop.width > 0 &&
		Number.isSafeInteger(crop.height) &&
		crop.height > 0
	);
}

export function createCroppedFilename(
	filename: string,
	mode: CropAspectMode,
	size: Pick<PixelCrop, "width" | "height">,
): string {
	const extensionIndex = filename.lastIndexOf(".");
	const hasExtension = extensionIndex > 0;
	const extension = hasExtension ? filename.slice(extensionIndex) : "";
	const stem = hasExtension ? filename.slice(0, extensionIndex) : filename;
	const base = stem.replace(REPEATED_LEGACY_CROP_SUFFIX, "") || stem;
	const descriptor =
		mode === "original" || mode === "freeform"
			? `${size.width}x${size.height}`
			: mode.replace(":", "x");
	const suffix = `-${descriptor}`;
	const generatedStem = base.toLowerCase().endsWith(suffix.toLowerCase())
		? base
		: `${base}${suffix}`;
	return `${generatedStem}${extension}`;
}

export function createCroppedImageFile(
	source: CanvasImageSource,
	crop: PixelCrop,
	filename: string,
	mimeType: string,
): Promise<File> {
	if (!CROPPABLE_MIME_TYPES.has(mimeType)) {
		return Promise.reject(new Error("Unsupported crop MIME type"));
	}
	if (!isSafeCrop(crop)) {
		return Promise.reject(new Error("Invalid crop rectangle"));
	}

	const canvas = document.createElement("canvas");
	canvas.width = crop.width;
	canvas.height = crop.height;
	const context = canvas.getContext("2d");
	if (!context) return Promise.reject(new Error("Canvas is unavailable"));
	context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

	return new Promise((resolve, reject) => {
		const complete = (blob: Blob | null) => {
			if (!blob) {
				reject(new Error("Cropped image could not be encoded"));
				return;
			}
			if (blob.type !== mimeType) {
				reject(new Error("Cropped image MIME type changed during encoding"));
				return;
			}
			resolve(new File([blob], filename, { type: mimeType, lastModified: Date.now() }));
		};

		if (mimeType === "image/png") {
			canvas.toBlob(complete, mimeType);
			return;
		}
		canvas.toBlob(complete, mimeType, 0.92);
	});
}
