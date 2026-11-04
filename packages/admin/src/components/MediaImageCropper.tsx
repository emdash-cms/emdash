import { useLingui } from "@lingui/react/macro";
import * as React from "react";
import ReactCrop, {
	centerCrop,
	convertToPixelCrop,
	makeAspectCrop,
	type PercentCrop,
	type PixelCrop as DisplayPixelCrop,
} from "react-image-crop";

import type { PixelCrop } from "../lib/crop-image.js";
import { useContainedMediaSize } from "./useContainedMediaSize.js";

const HANDLE_TARGET_SIZE = 24;
const FREEFORM_HANDLES_PER_EDGE = 3;
const FIXED_HANDLES_PER_EDGE = 2;

export type MediaCropSelection = PercentCrop;

function initialCrop(width: number, height: number, aspect?: number): PercentCrop {
	if (!aspect) return { unit: "%", x: 0, y: 0, width: 100, height: 100 };
	return centerCrop(
		makeAspectCrop({ unit: "%", width: 100 }, aspect, width, height),
		width,
		height,
	);
}

function naturalPixelCrop(image: HTMLImageElement, crop: DisplayPixelCrop): PixelCrop {
	const bounds = image.getBoundingClientRect();
	const scaleX = image.naturalWidth / bounds.width;
	const scaleY = image.naturalHeight / bounds.height;
	const x = Math.min(image.naturalWidth - 1, Math.max(0, Math.round(crop.x * scaleX)));
	const y = Math.min(image.naturalHeight - 1, Math.max(0, Math.round(crop.y * scaleY)));
	return {
		x,
		y,
		width: Math.max(1, Math.min(image.naturalWidth - x, Math.round(crop.width * scaleX))),
		height: Math.max(1, Math.min(image.naturalHeight - y, Math.round(crop.height * scaleY))),
	};
}

export interface MediaImageCropperProps {
	src: string;
	sourceSize?: { width: number; height: number };
	crop?: MediaCropSelection;
	aspect?: number;
	disabled?: boolean;
	onCropChange: (crop: MediaCropSelection) => void;
	onCropComplete: (crop: PixelCrop) => void;
	onSourceReady: (size: { width: number; height: number }) => void;
	onSourceError: () => void;
	onImageReady?: (image: HTMLImageElement | null) => void;
}

export function MediaImageCropper({
	src,
	sourceSize: knownSourceSize,
	crop,
	aspect,
	disabled = false,
	onCropChange,
	onCropComplete,
	onSourceReady,
	onSourceError,
	onImageReady,
}: MediaImageCropperProps) {
	const { t } = useLingui();
	const imageRef = React.useRef<HTMLImageElement | null>(null);
	const frameRef = React.useRef<HTMLDivElement>(null);
	const [loadedSourceSize, setLoadedSourceSize] = React.useState<{
		width: number;
		height: number;
	} | null>(null);
	const displaySize = useContainedMediaSize(frameRef, loadedSourceSize ?? knownSourceSize ?? null);
	const [resizeAnnouncement, setResizeAnnouncement] = React.useState("");
	const handleSpan =
		HANDLE_TARGET_SIZE * (aspect ? FIXED_HANDLES_PER_EDGE : FREEFORM_HANDLES_PER_EDGE);
	const minimumCropWidth = displaySize
		? Math.max(
				1,
				Math.min(displaySize.width, aspect && aspect > 1 ? handleSpan * aspect : handleSpan),
			)
		: 1;
	const minimumCropHeight = displaySize
		? Math.max(
				1,
				Math.min(displaySize.height, aspect && aspect <= 1 ? handleSpan / aspect : handleSpan),
			)
		: 1;
	const ariaLabels = React.useMemo(
		() => ({
			cropArea: t`Crop selection. Use the Arrow keys to move it.`,
			nwDragHandle: t`Resize crop from top-left corner. Use the Arrow keys to resize.`,
			nDragHandle: t`Resize crop from top edge. Use the Arrow keys to resize.`,
			neDragHandle: t`Resize crop from top-right corner. Use the Arrow keys to resize.`,
			eDragHandle: t`Resize crop from right edge. Use the Arrow keys to resize.`,
			seDragHandle: t`Resize crop from bottom-right corner. Use the Arrow keys to resize.`,
			sDragHandle: t`Resize crop from bottom edge. Use the Arrow keys to resize.`,
			swDragHandle: t`Resize crop from bottom-left corner. Use the Arrow keys to resize.`,
			wDragHandle: t`Resize crop from left edge. Use the Arrow keys to resize.`,
		}),
		[t],
	);

	const emitCropComplete = React.useCallback(
		(displayCrop: DisplayPixelCrop, announce: boolean) => {
			const image = imageRef.current;
			if (!image || displayCrop.width <= 0 || displayCrop.height <= 0) return;
			const pixels = naturalPixelCrop(image, displayCrop);
			onCropComplete(pixels);
			if (announce) {
				setResizeAnnouncement(t`Crop area ${pixels.width} by ${pixels.height} pixels.`);
			}
		},
		[onCropComplete, t],
	);

	React.useEffect(() => {
		if (crop || !displaySize || !loadedSourceSize || !imageRef.current) return;
		const bounds = imageRef.current.getBoundingClientRect();
		const nextCrop = initialCrop(bounds.width, bounds.height, aspect);
		onCropChange(nextCrop);
		emitCropComplete(convertToPixelCrop(nextCrop, bounds.width, bounds.height), false);
	}, [aspect, crop, displaySize, emitCropComplete, loadedSourceSize, onCropChange]);

	return (
		<div className="grid min-w-0 gap-4">
			<div
				ref={frameRef}
				className="emdash-image-cropper emdash-media-transparency-grid flex h-64 min-w-0 items-center justify-center overflow-hidden rounded-xl ring ring-kumo-line md:h-80"
				data-testid="media-image-cropper-frame"
				inert={disabled || undefined}
			>
				<ReactCrop
					crop={crop}
					aspect={aspect}
					disabled={disabled}
					keepSelection
					ruleOfThirds
					minWidth={minimumCropWidth}
					minHeight={minimumCropHeight}
					ariaLabels={ariaLabels}
					className="emdash-react-image-crop max-h-full max-w-full"
					style={displaySize ?? undefined}
					onChange={(displayCrop, percentCrop) => {
						onCropChange(percentCrop);
						emitCropComplete(displayCrop, false);
					}}
					onComplete={(displayCrop) => emitCropComplete(displayCrop, true)}
				>
					<img
						ref={(image) => {
							imageRef.current = image;
							onImageReady?.(image);
						}}
						src={src}
						alt=""
						draggable={false}
						className="block max-h-64 max-w-full object-contain md:max-h-80"
						style={displaySize ? { width: "100%", height: "100%" } : undefined}
						onLoad={(event) => {
							const image = event.currentTarget;
							if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
							setLoadedSourceSize({ width: image.naturalWidth, height: image.naturalHeight });
							onSourceReady({ width: image.naturalWidth, height: image.naturalHeight });
						}}
						onError={() => {
							onImageReady?.(null);
							onSourceError();
						}}
					/>
				</ReactCrop>
			</div>

			<p className="sr-only" role="status">
				{resizeAnnouncement}
			</p>
		</div>
	);
}
