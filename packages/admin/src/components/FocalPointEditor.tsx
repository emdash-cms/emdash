import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import {
	fallbackToOriginalThumbnail,
	getMediaObjectPosition,
	type MediaFocalPoint,
} from "../lib/media-utils.js";
import { useContainedMediaSize } from "./useContainedMediaSize.js";

interface FocalPointEditorProps {
	src: string;
	fallbackSrc?: string;
	sourceSize?: { width: number; height: number };
	alt: string;
	editing: boolean;
	disabled: boolean;
	point: MediaFocalPoint | null;
	descriptionId: string;
	onChange: (point: MediaFocalPoint) => void;
	onReadyChange?: (ready: boolean) => void;
	editorFrameRef?: React.RefObject<HTMLDivElement | null>;
}

interface FocalPointPreviewsProps extends Pick<
	FocalPointEditorProps,
	"src" | "fallbackSrc" | "point"
> {
	firstPreviewRef?: React.RefObject<HTMLDivElement | null>;
}

const KEY_MOVES: Record<string, [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};
const clamp = (value: number) => Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));

export function FocalPointPreviews({
	src,
	fallbackSrc,
	point,
	firstPreviewRef,
}: FocalPointPreviewsProps) {
	const { t } = useLingui();
	const current = point ?? { focalX: 0.5, focalY: 0.5 };
	const objectPosition = getMediaObjectPosition(current)!;
	const previews = [
		["portrait", t`Portrait`, "aspect-[4/5]"],
		["square", t`Square`, "aspect-square"],
		["landscape", t`Landscape`, "aspect-video"],
	] as const;

	return (
		<div className="grid w-full grid-cols-3 items-end gap-2" data-testid="focal-preview-group">
			{previews.map(([id, label, ratio]) => (
				<figure key={id} className="grid w-full min-w-0 gap-1">
					<div
						ref={id === "portrait" ? firstPreviewRef : undefined}
						className={`emdash-media-transparency-grid overflow-hidden rounded-lg ring ring-kumo-line ${ratio}`}
					>
						<img
							key={src}
							src={src}
							alt=""
							data-testid={`focal-preview-${id}`}
							className="h-full w-full object-cover"
							style={{ objectPosition }}
							onError={(event) => {
								if (fallbackSrc) fallbackToOriginalThumbnail(event.currentTarget, fallbackSrc);
							}}
						/>
					</div>
					<figcaption className="truncate text-center text-sm text-kumo-subtle">{label}</figcaption>
				</figure>
			))}
		</div>
	);
}

export function FocalPointEditor({
	src,
	fallbackSrc,
	sourceSize: knownSourceSize,
	alt,
	editing,
	disabled,
	point,
	descriptionId,
	onChange,
	onReadyChange,
	editorFrameRef,
}: FocalPointEditorProps) {
	const { t } = useLingui();
	const activePointerRef = React.useRef<number | null>(null);
	const frameRef = React.useRef<HTMLDivElement>(null);
	const [loadedSource, setLoadedSource] = React.useState<{
		src: string;
		width: number;
		height: number;
	} | null>(null);
	const ready = loadedSource?.src === src;
	const loadedSourceSize = ready ? loadedSource : null;
	const [announcement, setAnnouncement] = React.useState("");
	const displaySize = useContainedMediaSize(frameRef, loadedSourceSize ?? knownSourceSize ?? null);
	const current = point ?? { focalX: 0.5, focalY: 0.5 };
	const setFrameRef = React.useCallback(
		(node: HTMLDivElement | null) => {
			frameRef.current = node;
			if (editorFrameRef) editorFrameRef.current = node;
		},
		[editorFrameRef],
	);

	const announce = (next: MediaFocalPoint) =>
		setAnnouncement(
			t`Horizontal ${Math.round(next.focalX * 100)}%, vertical ${Math.round(next.focalY * 100)}%`,
		);
	const releasePointer = (event: React.PointerEvent<HTMLButtonElement>) => {
		if (activePointerRef.current !== event.pointerId) return;
		activePointerRef.current = null;
		if (
			event.type !== "lostpointercapture" &&
			event.currentTarget.hasPointerCapture(event.pointerId)
		) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};
	const handlePointer = (event: React.PointerEvent<HTMLButtonElement>) => {
		if (event.type === "pointerdown") {
			if (activePointerRef.current !== null) return;
			activePointerRef.current = event.pointerId;
			event.currentTarget.setPointerCapture(event.pointerId);
		} else if (activePointerRef.current !== event.pointerId) {
			return;
		}
		if (event.type === "pointercancel" || event.type === "lostpointercapture") {
			return releasePointer(event);
		}
		const bounds = event.currentTarget.getBoundingClientRect();
		if (bounds.width && bounds.height) {
			const next = {
				focalX: clamp((event.clientX - bounds.left) / bounds.width),
				focalY: clamp((event.clientY - bounds.top) / bounds.height),
			};
			onChange(next);
			if (event.type === "pointerup") announce(next);
		}
		if (event.type === "pointerup") releasePointer(event);
	};
	const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		const move = KEY_MOVES[event.key];
		if (!move) return;
		event.preventDefault();
		const step = event.shiftKey ? 0.05 : 0.01;
		const next = {
			focalX: clamp(current.focalX + move[0] * step),
			focalY: clamp(current.focalY + move[1] * step),
		};
		onChange(next);
		announce(next);
	};

	return (
		<div className="grid gap-4">
			<div
				ref={setFrameRef}
				aria-busy={!ready}
				className={`${ready ? "emdash-media-transparency-grid" : "bg-kumo-tint"} flex h-64 items-center justify-center overflow-hidden rounded-xl ring ring-kumo-line md:h-80`}
			>
				<div
					className="relative inline-flex max-h-full max-w-full"
					style={displaySize ?? undefined}
				>
					<img
						key={src}
						src={src}
						alt={alt}
						className="block max-h-64 max-w-full object-contain md:max-h-80"
						style={displaySize ? { width: "100%", height: "100%" } : undefined}
						draggable={false}
						onLoad={(event) => {
							const image = event.currentTarget;
							setLoadedSource({
								src,
								width: image.naturalWidth,
								height: image.naturalHeight,
							});
							onReadyChange?.(true);
						}}
						onError={(event) => {
							const image = event.currentTarget;
							if (fallbackSrc && !image.dataset.thumbFallback) {
								fallbackToOriginalThumbnail(image, fallbackSrc);
								return;
							}
							setLoadedSource(null);
							onReadyChange?.(false);
						}}
					/>
					{editing && ready && (
						<button
							type="button"
							aria-label={t`Focal point. Use arrow keys to move it.`}
							aria-describedby={descriptionId}
							disabled={disabled}
							className="absolute inset-0 cursor-crosshair touch-none rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
							onPointerDown={handlePointer}
							onPointerMove={handlePointer}
							onPointerUp={handlePointer}
							onPointerCancel={handlePointer}
							onLostPointerCapture={handlePointer}
							onKeyDown={handleKeyDown}
						>
							<span
								aria-hidden="true"
								className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-kumo-brand ring-2 ring-kumo-base"
								style={{ left: `${current.focalX * 100}%`, top: `${current.focalY * 100}%` }}
							/>
						</button>
					)}
				</div>
			</div>

			<p role="status" aria-live="polite" className="sr-only">
				{announcement}
			</p>
		</div>
	);
}
