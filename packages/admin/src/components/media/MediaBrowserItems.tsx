import { Badge, Button, LayerCard, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowDown, ArrowUp, Check, FolderSimple, WarningCircle, X } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaFolder, MediaItem } from "../../lib/api/media.js";
import {
	fallbackToOriginalThumbnail,
	formatFileSize,
	getFileIcon,
	getMediaObjectPosition,
	getMediaPreviewUrl,
	getMediaThumbnailUrl,
} from "../../lib/media-utils.js";
import { cn } from "../../lib/utils.js";
import type { MediaUploadJob } from "./useMediaUploadQueue.js";

export const MEDIA_BROWSER_PAGE_SIZES = [35, 70, 90];
export const MAX_MEDIA_PAGE_DROPDOWN_ITEMS = 100;

export function mimeForMediaTypeFilter(value: string): string | string[] | undefined {
	switch (value) {
		case "image":
			return "image/";
		case "video":
			return "video/";
		case "audio":
			return "audio/";
		case "document":
			return ["application/", "text/"];
		default:
			return undefined;
	}
}

function formatFileFormat(mimeType: string): string {
	return (mimeType.split("/").at(-1)?.split("+")[0] || mimeType).toUpperCase();
}

interface MediaBrowserItemProps {
	item: MediaItem;
	layout: "grid" | "list";
	selected?: boolean;
	selectable?: boolean;
	onClick?: (event: React.MouseEvent<HTMLElement>) => void;
	onDimensionsLoaded?: (width: number, height: number) => void;
	className?: string;
	mediaDraggable?: boolean;
}

export function MediaBrowserItem({
	item,
	layout,
	selected = false,
	selectable = false,
	onClick,
	onDimensionsLoaded,
	className,
	mediaDraggable,
}: MediaBrowserItemProps) {
	const isImage = item.mimeType.startsWith("image/");
	const hasVisualPreview = Boolean(item.url) && (isImage || Boolean(item.provider));
	const needsDimensions = hasVisualPreview && (!item.width || !item.height);
	const previewUrl = item.url ? getMediaPreviewUrl(item.url, item.contentHash) : "";
	const imageUrl =
		needsDimensions && onDimensionsLoaded
			? previewUrl
			: getMediaThumbnailUrl(item.url, item.mimeType, undefined, item.contentHash);

	const preview = hasVisualPreview ? (
		<img
			src={imageUrl}
			alt={selectable ? "" : item.alt || item.filename}
			draggable={false}
			className="emdash-media-transparency-grid h-full w-full object-cover"
			style={{ objectPosition: getMediaObjectPosition(item) }}
			onLoad={(event) => {
				if (!needsDimensions || !onDimensionsLoaded) return;
				const image = event.currentTarget;
				if (image.naturalWidth && image.naturalHeight) {
					onDimensionsLoaded(image.naturalWidth, image.naturalHeight);
				}
			}}
			onError={(event) => fallbackToOriginalThumbnail(event.currentTarget, previewUrl)}
		/>
	) : (
		<div className="flex h-full w-full items-center justify-center bg-kumo-tint">
			<span className={layout === "grid" ? "text-4xl" : "text-2xl"} aria-hidden="true">
				{getFileIcon(item.mimeType)}
			</span>
		</div>
	);

	if (layout === "list") {
		return (
			<LayerCard
				render={<button type="button" />}
				onClick={onClick}
				aria-label={item.filename}
				aria-pressed={selectable ? selected : undefined}
				data-media-layout="list"
				data-media-draggable={mediaDraggable || undefined}
				className={cn(
					"grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-start focus-visible:ring-2 focus-visible:ring-kumo-brand",
					selected ? "ring-2 ring-kumo-brand" : "hover:ring-kumo-brand/50",
					className,
				)}
			>
				<div className="h-10 w-14 overflow-hidden rounded-md">{preview}</div>
				<div className="min-w-0">
					<p dir="auto" className="truncate text-sm font-medium leading-5" title={item.filename}>
						{item.filename}
					</p>
					<p className="truncate text-sm text-kumo-subtle">
						{item.mimeType} · {formatFileSize(item.size)}
					</p>
				</div>
				{selectable && selected ? (
					<span className="flex size-6 items-center justify-center rounded-full bg-kumo-brand text-kumo-inverse">
						<Check className="size-4" weight="bold" aria-hidden="true" />
					</span>
				) : (
					<Badge variant="secondary" className="hidden h-5 min-w-11 justify-center sm:flex">
						<span className="text-[11px] leading-none text-kumo-default/75">
							{formatFileFormat(item.mimeType)}
						</span>
					</Badge>
				)}
			</LayerCard>
		);
	}

	return (
		<LayerCard
			render={<button type="button" />}
			onClick={onClick}
			aria-label={item.filename}
			aria-pressed={selectable ? selected : undefined}
			data-media-layout="grid"
			data-media-draggable={mediaDraggable || undefined}
			className={cn(
				"group relative w-full min-w-0 text-start focus-visible:ring-2 focus-visible:ring-kumo-brand",
				selected ? "ring-2 ring-kumo-brand" : "hover:ring-kumo-brand/50",
				className,
			)}
		>
			<LayerCard.Primary className="aspect-video p-0">{preview}</LayerCard.Primary>
			<LayerCard.Secondary className="my-0 min-w-0 justify-between px-3 py-2.5 text-sm text-kumo-default">
				<span
					dir="auto"
					title={item.filename}
					className="min-w-0 flex-1 truncate font-medium leading-5"
				>
					{item.filename}
				</span>
				<Badge variant="secondary" className="h-5 min-w-11 justify-center rounded-md px-2 py-0">
					<span className="text-[11px] leading-none text-kumo-default/75">
						{formatFileFormat(item.mimeType)}
					</span>
				</Badge>
			</LayerCard.Secondary>
			{selectable && selected && (
				<span className="absolute end-2 top-2 flex size-6 items-center justify-center rounded-full bg-kumo-brand text-kumo-inverse ring-2 ring-kumo-base">
					<Check className="size-4" weight="bold" aria-hidden="true" />
				</span>
			)}
		</LayerCard>
	);
}

export function MediaBrowserFolder({
	folder,
	onOpen,
}: {
	folder: MediaFolder;
	onOpen: () => void;
}) {
	const { t } = useLingui();
	return (
		<LayerCard
			render={<button type="button" />}
			onClick={onOpen}
			aria-label={t`Open folder ${folder.name}`}
			className="flex w-full min-w-0 items-center gap-3 px-3 py-3 text-start hover:ring-kumo-brand/50 focus-visible:ring-2 focus-visible:ring-kumo-brand"
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-kumo-tint text-emdash-media-folder">
				<FolderSimple className="size-5" weight="fill" aria-hidden="true" />
			</span>
			<span dir="auto" className="min-w-0 truncate text-sm font-medium" title={folder.name}>
				{folder.name}
			</span>
		</LayerCard>
	);
}

export function MediaUploadPlaceholder({
	job,
	layout,
	onRetry,
	onRemove,
}: {
	job: MediaUploadJob<unknown>;
	layout: "grid" | "list";
	onRetry: () => void;
	onRemove: () => void;
}) {
	const { t } = useLingui();
	const failed = job.status === "failed";
	const status = failed ? t`Upload failed` : t`Uploading`;
	const statusIcon = failed ? (
		<WarningCircle className="size-5 text-kumo-danger" weight="fill" aria-hidden="true" />
	) : (
		<Loader size="sm" />
	);
	const actions = failed ? (
		<div className="flex flex-wrap items-center gap-1">
			<Button variant="ghost" size="sm" onClick={onRetry} aria-label={t`Retry ${job.file.name}`}>
				{t`Retry`}
			</Button>
			<Button variant="ghost" size="sm" onClick={onRemove} aria-label={t`Remove ${job.file.name}`}>
				{t`Remove`}
			</Button>
		</div>
	) : null;

	if (layout === "list") {
		return (
			<LayerCard
				data-upload-status={job.status}
				className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3 bg-kumo-tint/60 px-3 py-2 opacity-75"
			>
				<div className="flex h-10 w-14 items-center justify-center rounded-md bg-kumo-recessed">
					{statusIcon}
				</div>
				<div className="min-w-0">
					<p dir="auto" className="truncate text-sm font-medium" title={job.file.name}>
						{job.file.name}
					</p>
					<p className={cn("text-sm", failed ? "text-kumo-danger" : "text-kumo-subtle")}>
						{status}
					</p>
				</div>
				{actions}
			</LayerCard>
		);
	}

	return (
		<LayerCard data-upload-status={job.status} className="min-w-0 bg-kumo-tint/60 opacity-75">
			<LayerCard.Primary className="flex aspect-video items-center justify-center bg-kumo-recessed p-0">
				{statusIcon}
			</LayerCard.Primary>
			<LayerCard.Secondary className="my-0 grid min-w-0 gap-1 px-3 py-2.5">
				<p dir="auto" className="truncate text-sm font-medium" title={job.file.name}>
					{job.file.name}
				</p>
				<p className={cn("text-sm", failed ? "text-kumo-danger" : "text-kumo-subtle")}>{status}</p>
				{actions}
			</LayerCard.Secondary>
		</LayerCard>
	);
}

export function MediaSelectionTrayItem({
	item,
	position,
	total,
	onMoveEarlier,
	onMoveLater,
	onRemove,
}: {
	item: MediaItem;
	position: number;
	total: number;
	onMoveEarlier: () => void;
	onMoveLater: () => void;
	onRemove: () => void;
}) {
	const { t } = useLingui();
	const image = item.mimeType.startsWith("image/") && item.url;
	return (
		<LayerCard
			render={<li />}
			className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
		>
			<div className="h-10 w-14 overflow-hidden rounded-md bg-kumo-tint">
				{image ? (
					<img
						src={getMediaThumbnailUrl(item.url, item.mimeType, 80, item.contentHash)}
						alt=""
						className="emdash-media-transparency-grid h-full w-full object-cover"
						style={{ objectPosition: getMediaObjectPosition(item) }}
					/>
				) : (
					<span className="flex h-full items-center justify-center text-xl" aria-hidden="true">
						{getFileIcon(item.mimeType)}
					</span>
				)}
			</div>
			<div className="min-w-0">
				<p dir="auto" className="truncate text-sm font-medium" title={item.filename}>
					{item.filename}
				</p>
				<p className="text-sm text-kumo-subtle">{t`${position} of ${total}`}</p>
			</div>
			<div className="flex items-center gap-1">
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					disabled={position === 1}
					onClick={onMoveEarlier}
					aria-label={t`Move ${item.filename} earlier`}
					icon={<ArrowUp aria-hidden="true" />}
				/>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					disabled={position === total}
					onClick={onMoveLater}
					aria-label={t`Move ${item.filename} later`}
					icon={<ArrowDown aria-hidden="true" />}
				/>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					onClick={onRemove}
					aria-label={t`Remove ${item.filename} from selection`}
					icon={<X aria-hidden="true" />}
				/>
			</div>
		</LayerCard>
	);
}
