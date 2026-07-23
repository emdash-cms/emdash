/**
 * Image field with media picker
 *
 * Stores full image metadata including dimensions for responsive images.
 * Handles backwards compatibility with legacy string URLs.
 *
 * Extracted from ContentEditor so non-top-level field UIs (e.g. repeater
 * sub-fields) can reuse the same picker without a circular import.
 */

import { Button, Label, LayerCard, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Image as ImageIcon, ImageBroken, X } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../lib/api";
import { metaString } from "../lib/media-utils";
import { FieldHelpLabel } from "./FieldHelpLabel.js";
import { MediaPickerModal } from "./MediaPickerModal";

/**
 * Image field value - matches emdash's MediaValue type
 */
export interface ImageFieldValue {
	id: string;
	/** Provider ID (e.g., "local", "cloudflare-images") */
	provider?: string;
	/** Direct URL for local media or legacy data */
	src?: string;
	/** Preview URL for admin display (separate from src used for rendering) */
	previewUrl?: string;
	filename?: string;
	mimeType?: string;
	alt?: string;
	width?: number;
	height?: number;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
	/** Provider-specific metadata */
	meta?: Record<string, unknown>;
}

export interface ImageFieldRendererProps {
	id?: string;
	label: string;
	description?: string;
	value: ImageFieldValue | string | undefined;
	onChange: (value: ImageFieldValue | null) => void;
	required?: boolean;
	allowedMimeTypes?: string[];
	fieldId?: string;
	variant?: "default" | "featured";
}

export function ImageFieldRenderer({
	id,
	label,
	description,
	value,
	onChange,
	required,
	allowedMimeTypes,
	fieldId,
	variant = "default",
}: ImageFieldRendererProps) {
	const { t } = useLingui();
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [imageBroken, setImageBroken] = React.useState(false);
	// Normalize value to get display URL (handles both object and legacy string)
	// Prefer previewUrl for admin display, fall back to src, then derive from storageKey/id
	const displayUrl =
		typeof value === "string"
			? value
			: value?.previewUrl ||
				value?.src ||
				(value && (!value.provider || value.provider === "local")
					? `/_emdash/api/media/file/${typeof value.meta?.storageKey === "string" ? value.meta.storageKey : value.id}`
					: undefined);

	React.useEffect(() => {
		setImageBroken(false);
	}, [displayUrl]);

	const handleSelect = (item: MediaItem) => {
		const isLocalProvider = !item.provider || item.provider === "local";

		onChange({
			id: item.id,
			provider: item.provider || "local",
			// Local media derives URLs from meta.storageKey at display time — no src needed
			// External providers cache a preview URL for admin display
			previewUrl: isLocalProvider ? undefined : item.url,
			alt: item.alt || "",
			width: item.width,
			height: item.height,
			filename: item.filename,
			mimeType: item.mimeType,
			// Cache LQIP alongside dimensions so embeds render a placeholder without a
			// runtime lookup. Fall back to `meta` for providers that stash it there.
			blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
			dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
			meta: isLocalProvider ? { ...item.meta, storageKey: item.storageKey } : item.meta,
		});
	};

	const handleRemove = () => {
		onChange(null);
	};

	const isFeatured = variant === "featured";
	const selectedFilename =
		typeof value === "object" && value.filename ? value.filename : t`Selected image`;
	const dimensions =
		typeof value === "object" && typeof value.width === "number" && typeof value.height === "number"
			? `${value.width} × ${value.height}`
			: undefined;
	const mimeType = typeof value === "object" && value.mimeType ? value.mimeType : undefined;
	const metadata = [dimensions, mimeType].filter(Boolean).join(" · ");

	const featuredCard = displayUrl ? (
		<LayerCard className="grid w-full grid-cols-1 rounded-xl p-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
			<div className="m-2 aspect-[3/2] min-h-28 overflow-hidden rounded bg-kumo-muted ring ring-kumo-line sm:aspect-auto">
				{imageBroken ? (
					<div className="flex h-full min-h-28 items-center justify-center gap-2 text-kumo-subtle">
						<ImageBroken className="h-5 w-5" aria-hidden="true" />
						<Text as="span" variant="secondary">
							{t`Image not found`}
						</Text>
					</div>
				) : (
					<img
						src={displayUrl}
						alt=""
						className="h-full w-full object-cover"
						onError={() => setImageBroken(true)}
					/>
				)}
			</div>
			<div className="flex min-w-0 flex-col justify-center gap-2 px-4 py-3">
				<div className="grid min-w-0 gap-1">
					<Text as="p" bold truncate>
						{selectedFilename}
					</Text>
					{metadata && (
						<Text as="p" variant="secondary" truncate>
							<bdi dir="ltr">{metadata}</bdi>
						</Text>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
						{t`Change`}
					</Button>
					<Button
						type="button"
						size="sm"
						shape="square"
						variant="secondary-destructive"
						onClick={handleRemove}
						aria-label={t`Remove image`}
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			</div>
		</LayerCard>
	) : null;

	return (
		<div id={id} className="grid gap-2">
			{description ? (
				<FieldHelpLabel
					help={description}
					helpLabel={t`More information about ${label}`}
					labelClassName="text-base font-medium text-kumo-default"
				>
					{label}
				</FieldHelpLabel>
			) : (
				<Label>{label}</Label>
			)}
			{isFeatured && displayUrl ? (
				featuredCard
			) : displayUrl ? (
				imageBroken ? (
					<div className="relative group">
						<div className="min-h-20 rounded-lg border bg-kumo-muted flex items-center justify-center gap-2 text-kumo-subtle">
							<ImageBroken className="h-5 w-5" />
							<span className="text-sm">{t`Image not found`}</span>
						</div>
						<div className="absolute top-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() => setPickerOpen(true)}
							>
								{t`Change`}
							</Button>
							<Button
								type="button"
								shape="square"
								variant="destructive"
								className="h-8 w-8"
								onClick={handleRemove}
								aria-label={t`Remove image`}
							>
								<X className="h-4 w-4" />
							</Button>
						</div>
					</div>
				) : (
					<div className="relative group">
						<img
							src={displayUrl}
							alt=""
							className="max-h-48 min-h-20 rounded-lg border object-cover"
							onError={() => setImageBroken(true)}
						/>
						<div className="absolute top-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() => setPickerOpen(true)}
							>
								{t`Change`}
							</Button>
							<Button
								type="button"
								shape="square"
								variant="destructive"
								className="h-8 w-8"
								onClick={handleRemove}
								aria-label={t`Remove image`}
							>
								<X className="h-4 w-4" />
							</Button>
						</div>
					</div>
				)
			) : (
				<Button
					type="button"
					variant="outline"
					className={
						isFeatured
							? "h-32 w-full justify-center bg-kumo-control ring-kumo-line"
							: "h-32 w-full justify-center border-dashed bg-kumo-control"
					}
					onClick={() => setPickerOpen(true)}
				>
					<div className="flex flex-col items-center gap-2 text-kumo-subtle">
						<ImageIcon className="h-8 w-8" />
						<span>{t`Select image`}</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilters={
					allowedMimeTypes && allowedMimeTypes.length > 0 ? allowedMimeTypes : ["image/"]
				}
				fieldId={fieldId}
				title={t`Select ${label}`}
			/>
			{required && !displayUrl && (
				<p className="-mt-1 text-sm text-kumo-danger">{t`This field is required`}</p>
			)}
		</div>
	);
}
