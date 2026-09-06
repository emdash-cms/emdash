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
import { Image as ImageIcon, ImageBroken, ImageSquare, Moon, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchMediaItem, type MediaItem } from "../lib/api";
import {
	canonicalMediaProviderId,
	getMediaObjectPosition,
	getMediaPreviewUrl,
	metaString,
} from "../lib/media-utils.js";
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
	focalX?: number;
	focalY?: number;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
	/** Provider-specific metadata */
	meta?: Record<string, unknown>;
	/** Image the site shows instead of this one in a dark color scheme */
	darkVariant?: ImageFieldValue;
}

/**
 * Admin preview URL for a stored value: `previewUrl` for external providers,
 * `src` for legacy data, otherwise the local media file route.
 */
function mediaDisplayUrl(value: ImageFieldValue | string | undefined): string | undefined {
	if (typeof value === "string") return value;
	if (!value) return undefined;
	if (value.previewUrl || value.src) return value.previewUrl || value.src;
	if (!value.provider || value.provider === "local") {
		return `/_emdash/api/media/file/${encodeURIComponent(
			typeof value.meta?.storageKey === "string" ? value.meta.storageKey : value.id,
		)}`;
	}
	return undefined;
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
	/** Offer a second slot for the image shown in a dark color scheme */
	darkVariant?: boolean;
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
	darkVariant = false,
}: ImageFieldRendererProps) {
	const { t } = useLingui();
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [pickerTarget, setPickerTarget] = React.useState<"image" | "darkVariant">("image");
	const [imageBroken, setImageBroken] = React.useState(false);
	const [darkImageBroken, setDarkImageBroken] = React.useState(false);
	// A legacy string URL needs object form to carry a dark variant. The runtime
	// resolves the URL in `src` on save, so the provider linkage survives.
	const objectValue: ImageFieldValue | undefined =
		typeof value === "object" && value
			? value
			: typeof value === "string" && value
				? { id: "", src: value }
				: undefined;
	const darkValue = objectValue?.darkVariant;
	const currentMediaId =
		variant === "featured" &&
		objectValue?.id &&
		canonicalMediaProviderId(objectValue.provider) === "local"
			? objectValue.id
			: null;
	const { data: currentMedia } = useQuery({
		queryKey: ["media", currentMediaId],
		queryFn: ({ signal }) => fetchMediaItem(currentMediaId!, { signal }),
		enabled: currentMediaId !== null,
	});
	const currentDarkMediaId =
		variant === "featured" &&
		darkValue?.id &&
		canonicalMediaProviderId(darkValue.provider) === "local"
			? darkValue.id
			: null;
	const { data: currentDarkMedia } = useQuery({
		queryKey: ["media", currentDarkMediaId],
		queryFn: ({ signal }) => fetchMediaItem(currentDarkMediaId!, { signal }),
		enabled: currentDarkMediaId !== null,
	});
	const storedDisplayUrl = mediaDisplayUrl(value);
	const displayUrl = storedDisplayUrl
		? getMediaPreviewUrl(storedDisplayUrl, currentMedia?.contentHash)
		: undefined;
	const storedDarkDisplayUrl = mediaDisplayUrl(darkValue);
	const darkDisplayUrl = storedDarkDisplayUrl
		? getMediaPreviewUrl(storedDarkDisplayUrl, currentDarkMedia?.contentHash)
		: undefined;

	React.useEffect(() => {
		setImageBroken(false);
	}, [displayUrl]);

	React.useEffect(() => {
		setDarkImageBroken(false);
	}, [darkDisplayUrl]);

	const openPicker = (target: "image" | "darkVariant") => {
		setPickerTarget(target);
		setPickerOpen(true);
	};

	const handleSelect = (item: MediaItem) => {
		const provider = canonicalMediaProviderId(item.provider);
		const isLocalProvider = provider === "local";
		const isDirectUrl = provider === "external";

		const selected: ImageFieldValue = {
			id: item.id,
			provider,
			// Local media derives its URL from storageKey. Direct URLs persist src,
			// while external providers cache a preview URL for the admin.
			src: isDirectUrl ? item.url : undefined,
			previewUrl: !isLocalProvider && !isDirectUrl ? item.url : undefined,
			alt: item.alt || "",
			width: item.width,
			height: item.height,
			focalX: item.focalX ?? undefined,
			focalY: item.focalY ?? undefined,
			filename: item.filename,
			mimeType: item.mimeType,
			// Cache LQIP alongside dimensions so embeds render a placeholder without a
			// runtime lookup. Fall back to `meta` for providers that stash it there.
			blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
			dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
			meta: isLocalProvider ? { ...item.meta, storageKey: item.storageKey } : item.meta,
		};

		if (pickerTarget === "darkVariant") {
			if (objectValue) onChange({ ...objectValue, darkVariant: selected });
			return;
		}
		onChange(darkValue ? { ...selected, darkVariant: darkValue } : selected);
	};

	const handleRemove = () => {
		onChange(null);
	};

	const handleRemoveDarkVariant = () => {
		if (!objectValue) return;
		const next = { ...objectValue };
		delete next.darkVariant;
		onChange(next);
	};

	const isFeatured = variant === "featured";
	const selectedFilename =
		typeof value === "object" && value.filename ? value.filename : t`Selected image`;
	const currentWidth = currentMedia?.width ?? (typeof value === "object" ? value.width : undefined);
	const currentHeight =
		currentMedia?.height ?? (typeof value === "object" ? value.height : undefined);
	const dimensions =
		typeof currentWidth === "number" && typeof currentHeight === "number"
			? `${currentWidth} × ${currentHeight}`
			: undefined;
	const mimeType =
		currentMedia?.mimeType ??
		(typeof value === "object" && value.mimeType ? value.mimeType : undefined);
	const metadata = [dimensions, mimeType].filter(Boolean).join(" · ");
	const objectPosition =
		typeof value === "object" && value ? getMediaObjectPosition(value) : undefined;
	const darkObjectPosition = darkValue ? getMediaObjectPosition(darkValue) : undefined;
	const darkFilename = darkValue?.filename || t`Selected image`;

	const darkVariantSlot =
		darkVariant && objectValue && displayUrl ? (
			<div className="flex flex-wrap items-center gap-3">
				{darkDisplayUrl ? (
					<>
						<div className="h-12 w-16 shrink-0 overflow-hidden rounded bg-kumo-muted ring ring-kumo-line">
							{darkImageBroken ? (
								<div className="flex h-full items-center justify-center text-kumo-subtle">
									<ImageBroken className="h-5 w-5" aria-hidden="true" />
								</div>
							) : (
								<img
									src={darkDisplayUrl}
									alt=""
									className="h-full w-full object-cover"
									style={{ objectPosition: darkObjectPosition }}
									onError={() => setDarkImageBroken(true)}
								/>
							)}
						</div>
						<div className="grid min-w-0 flex-1 gap-0.5">
							<Text as="p" variant="secondary">
								{t`Dark mode variant`}
							</Text>
							<Text as="p" bold truncate>
								{darkFilename}
							</Text>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								icon={<ImageSquare />}
								onClick={() => openPicker("darkVariant")}
								aria-label={t`Replace dark mode variant`}
							>
								{t`Replace`}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="secondary-destructive"
								icon={<X />}
								onClick={handleRemoveDarkVariant}
								aria-label={t`Remove dark mode variant`}
							>
								{t`Remove`}
							</Button>
						</div>
					</>
				) : (
					<Button
						type="button"
						size="sm"
						variant="secondary"
						icon={<Moon />}
						onClick={() => openPicker("darkVariant")}
					>
						{t`Add dark mode variant`}
					</Button>
				)}
			</div>
		) : null;

	const featuredCard = displayUrl ? (
		<LayerCard className="grid w-full grid-cols-1 rounded-xl p-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
			<div className="m-2 aspect-[3/2] min-h-28 overflow-hidden rounded bg-kumo-tint ring ring-kumo-line">
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
						className="emdash-media-transparency-grid h-full w-full object-cover"
						style={{ objectPosition }}
						onError={() => setImageBroken(true)}
					/>
				)}
			</div>
			<div className="flex min-w-0 flex-col justify-center gap-3 px-4 py-3">
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
					<Button
						type="button"
						size="sm"
						variant="secondary"
						icon={<ImageSquare />}
						onClick={() => openPicker("image")}
					>
						{t`Replace`}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="secondary-destructive"
						icon={<X />}
						onClick={handleRemove}
						aria-label={t`Remove image`}
					>
						{t`Remove`}
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
						<div className="flex min-h-20 items-center justify-center gap-2 rounded-lg border bg-kumo-tint text-kumo-subtle">
							<ImageBroken className="h-5 w-5" />
							<span className="text-sm">{t`Image not found`}</span>
						</div>
						<div className="absolute top-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() => openPicker("image")}
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
							className="emdash-media-transparency-grid max-h-48 min-h-20 rounded-lg border object-cover"
							style={{ objectPosition }}
							onError={() => setImageBroken(true)}
						/>
						<div className="absolute top-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() => openPicker("image")}
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
					className="h-32 w-full justify-center border-dashed bg-kumo-control"
					onClick={() => openPicker("image")}
				>
					<div className="flex flex-col items-center gap-2 text-kumo-subtle">
						<ImageIcon className="h-8 w-8" />
						<span>{t`Select image`}</span>
					</div>
				</Button>
			)}
			{darkVariantSlot}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilters={
					allowedMimeTypes && allowedMimeTypes.length > 0 ? allowedMimeTypes : ["image/"]
				}
				fieldId={fieldId}
				title={
					pickerTarget === "darkVariant"
						? t`Select dark mode variant for ${label}`
						: t`Select ${label}`
				}
			/>
			{required && !displayUrl && (
				<p className="-mt-1 text-sm text-kumo-danger">{t`This field is required`}</p>
			)}
		</div>
	);
}
