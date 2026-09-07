/**
 * Image field with media picker
 *
 * Stores full image metadata including dimensions for responsive images.
 * Handles backwards compatibility with legacy string URLs.
 *
 * Extracted from ContentEditor so non-top-level field UIs (e.g. repeater
 * sub-fields) can reuse the same picker without a circular import.
 */

import { Button, DropdownMenu, Label, LayerCard, Text, Tooltip } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	Image as ImageIcon,
	ImageBroken,
	ImageSquare,
	DotsThree,
	Moon,
	PencilSimple,
	X,
} from "@phosphor-icons/react";
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
import { useMediaAssetEditor } from "./media/useMediaAssetEditor.js";
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

function mediaItemToImageFieldValue(item: MediaItem): ImageFieldValue {
	const provider = canonicalMediaProviderId(item.provider);
	const isLocalProvider = provider === "local";
	const isDirectUrl = provider === "external";
	return {
		id: item.id,
		provider,
		src: isDirectUrl ? item.url : undefined,
		previewUrl: !isLocalProvider && !isDirectUrl ? item.url : undefined,
		alt: item.alt || "",
		width: item.width,
		height: item.height,
		focalX: item.focalX ?? undefined,
		focalY: item.focalY ?? undefined,
		filename: item.filename,
		mimeType: item.mimeType,
		blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
		dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
		meta: isLocalProvider ? { ...item.meta, storageKey: item.storageKey } : item.meta,
	};
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
	const [mobileActionsOpen, setMobileActionsOpen] = React.useState(false);
	const [imageBroken, setImageBroken] = React.useState(false);
	const [darkImageBroken, setDarkImageBroken] = React.useState(false);
	const mobileImageActionsRef = React.useRef<HTMLButtonElement>(null);
	const [editedContentHashes, setEditedContentHashes] = React.useState<
		Record<string, string | null | undefined>
	>({});
	// A legacy string URL needs object form to carry a dark variant. The runtime
	// resolves the URL in `src` on save, so the provider linkage survives.
	const objectValue: ImageFieldValue | undefined =
		typeof value === "object" && value
			? value
			: typeof value === "string" && value
				? { id: "", src: value }
				: undefined;
	const darkValue = objectValue?.darkVariant;
	const handleAssetItemChanged = React.useCallback(
		(item: MediaItem) => {
			const selected = mediaItemToImageFieldValue(item);
			setEditedContentHashes((current) => ({ ...current, [item.id]: item.contentHash }));
			if (pickerTarget === "darkVariant") {
				if (objectValue) onChange({ ...objectValue, darkVariant: selected });
				return;
			}
			onChange(darkValue ? { ...selected, darkVariant: darkValue } : selected);
		},
		[darkValue, objectValue, onChange, pickerTarget],
	);
	const assetEditor = useMediaAssetEditor(handleAssetItemChanged);
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
	const primaryContentHash =
		objectValue?.id && Object.hasOwn(editedContentHashes, objectValue.id)
			? editedContentHashes[objectValue.id]
			: currentMedia?.contentHash;
	const displayUrl = storedDisplayUrl
		? getMediaPreviewUrl(storedDisplayUrl, primaryContentHash)
		: undefined;
	const storedDarkDisplayUrl = mediaDisplayUrl(darkValue);
	const darkContentHash =
		darkValue?.id && Object.hasOwn(editedContentHashes, darkValue.id)
			? editedContentHashes[darkValue.id]
			: currentDarkMedia?.contentHash;
	const darkDisplayUrl = storedDarkDisplayUrl
		? getMediaPreviewUrl(storedDarkDisplayUrl, darkContentHash)
		: undefined;

	React.useEffect(() => {
		setImageBroken(false);
	}, [displayUrl]);

	React.useEffect(() => {
		setDarkImageBroken(false);
	}, [darkDisplayUrl]);

	React.useEffect(() => {
		if (variant !== "featured") return;
		const desktop = window.matchMedia("(min-width: 640px)");
		const closeMobileActions = (event: MediaQueryListEvent) => {
			if (event.matches) setMobileActionsOpen(false);
		};
		desktop.addEventListener("change", closeMobileActions);
		return () => desktop.removeEventListener("change", closeMobileActions);
	}, [variant]);

	const openPicker = (target: "image" | "darkVariant") => {
		setPickerTarget(target);
		setPickerOpen(true);
	};

	const handleSelect = (item: MediaItem) => {
		const selected = mediaItemToImageFieldValue(item);

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
	const canEditPrimaryAsset = Boolean(
		objectValue?.id && canonicalMediaProviderId(objectValue.provider) === "local",
	);
	const canEditDarkAsset = Boolean(
		darkValue?.id && canonicalMediaProviderId(darkValue.provider) === "local",
	);
	const primaryActions = (
		<div
			className={
				isFeatured
					? "-m-0.5 hidden w-full min-w-0 items-center gap-2 overflow-x-auto overscroll-x-contain p-0.5 [scrollbar-width:none] sm:flex [&::-webkit-scrollbar]:hidden"
					: "flex flex-wrap items-center gap-2"
			}
			style={isFeatured ? { scrollbarWidth: "none" } : undefined}
		>
			<Button
				type="button"
				size="sm"
				variant="secondary"
				icon={<ImageSquare aria-hidden="true" />}
				onClick={() => openPicker("image")}
				disabled={assetEditor.isActive}
			>
				{t`Replace`}
			</Button>
			{canEditPrimaryAsset && (
				<Button
					type="button"
					size="sm"
					variant="secondary"
					icon={<PencilSimple aria-hidden="true" />}
					loading={assetEditor.isOpening && pickerTarget === "image"}
					onClick={(event) => {
						setPickerTarget("image");
						void assetEditor.openAssetEditor(objectValue!.id, event.currentTarget);
					}}
				>
					{t`Edit asset`}
				</Button>
			)}
			<Button
				type="button"
				size="sm"
				variant="secondary-destructive"
				icon={<X aria-hidden="true" />}
				onClick={handleRemove}
				disabled={assetEditor.isActive}
				aria-label={t`Remove image`}
			>
				{t`Remove`}
			</Button>
		</div>
	);
	const mobileFeaturedActions = (
		<DropdownMenu open={mobileActionsOpen} onOpenChange={setMobileActionsOpen}>
			<Tooltip
				content={t`Image actions`}
				side="top"
				className="cursor-pointer"
				render={
					<DropdownMenu.Trigger
						render={
							<Button
								ref={mobileImageActionsRef}
								type="button"
								shape="square"
								variant="ghost"
								icon={<DotsThree aria-hidden="true" />}
								loading={assetEditor.isOpening && pickerTarget === "image"}
								disabled={assetEditor.isActive}
								aria-label={t`Image actions`}
								aria-haspopup="menu"
								aria-expanded={mobileActionsOpen}
							/>
						}
					/>
				}
			/>
			<DropdownMenu.Content align="end" className="min-w-40 sm:hidden">
				<DropdownMenu.Item
					icon={<ImageSquare className="me-1.5 size-4" aria-hidden="true" />}
					onClick={() => openPicker("image")}
				>
					{t`Replace`}
				</DropdownMenu.Item>
				{canEditPrimaryAsset && (
					<DropdownMenu.Item
						icon={<PencilSimple className="me-1.5 size-4" aria-hidden="true" />}
						onClick={() => {
							setPickerTarget("image");
							void assetEditor.openAssetEditor(objectValue!.id, mobileImageActionsRef.current);
						}}
					>
						{t`Edit asset`}
					</DropdownMenu.Item>
				)}
				<DropdownMenu.Separator />
				<DropdownMenu.Item
					variant="danger"
					icon={<X className="me-1.5 size-4" aria-hidden="true" />}
					onClick={handleRemove}
				>
					{t`Remove`}
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu>
	);

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
						<div className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								icon={<ImageSquare aria-hidden="true" />}
								onClick={() => openPicker("darkVariant")}
								disabled={assetEditor.isActive}
								aria-label={t`Replace dark mode image`}
							>
								{t`Replace`}
							</Button>
							{canEditDarkAsset && (
								<Button
									type="button"
									size="sm"
									variant="secondary"
									icon={<PencilSimple aria-hidden="true" />}
									loading={assetEditor.isOpening && pickerTarget === "darkVariant"}
									onClick={(event) => {
										setPickerTarget("darkVariant");
										void assetEditor.openAssetEditor(darkValue!.id, event.currentTarget);
									}}
									aria-label={t`Edit dark mode asset`}
								>
									{t`Edit asset`}
								</Button>
							)}
							<Button
								type="button"
								size="sm"
								variant="secondary-destructive"
								icon={<X aria-hidden="true" />}
								onClick={handleRemoveDarkVariant}
								disabled={assetEditor.isActive}
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
						icon={<Moon aria-hidden="true" />}
						onClick={() => openPicker("darkVariant")}
						disabled={assetEditor.isActive}
					>
						{t`Add dark mode variant`}
					</Button>
				)}
			</div>
		) : null;

	const featuredCard = displayUrl ? (
		<LayerCard className="grid w-full grid-cols-[5rem_minmax(0,1fr)_auto] items-center rounded-xl p-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-stretch">
			<div
				className="emdash-featured-image-preview m-2 overflow-hidden rounded bg-kumo-tint ring ring-kumo-line"
				style={{ aspectRatio: "16 / 9" }}
			>
				{imageBroken ? (
					<div className="flex h-full items-center justify-center gap-2 text-kumo-subtle">
						<ImageBroken className="h-5 w-5" aria-hidden="true" />
						<Text as="span" variant="secondary" DANGEROUS_className="sr-only sm:not-sr-only">
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
			<div className="flex min-w-0 flex-col justify-center px-2 py-2 sm:px-4 sm:py-3">
				<div className="flex w-full min-w-0 flex-col gap-1.5 sm:translate-y-1.5 sm:gap-3">
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
					{primaryActions}
				</div>
			</div>
			<div className="me-2 sm:hidden">{mobileFeaturedActions}</div>
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
					<div className="grid gap-2">
						<div className="flex min-h-20 items-center justify-center gap-2 rounded-lg border bg-kumo-tint text-kumo-subtle">
							<ImageBroken className="h-5 w-5" />
							<span className="text-sm">{t`Image not found`}</span>
						</div>
						{primaryActions}
					</div>
				) : (
					<div className="grid gap-2">
						<img
							src={displayUrl}
							alt=""
							className="emdash-media-transparency-grid max-h-48 min-h-20 rounded-lg border object-cover"
							style={{ objectPosition }}
							onError={() => setImageBroken(true)}
						/>
						{primaryActions}
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
						? darkDisplayUrl
							? t`Replace dark mode variant for ${label}`
							: t`Select dark mode variant for ${label}`
						: displayUrl
							? t`Replace ${label}`
							: t`Select ${label}`
				}
				confirmLabel={
					pickerTarget === "darkVariant"
						? darkDisplayUrl
							? t`Replace`
							: undefined
						: displayUrl
							? t`Replace`
							: undefined
				}
			/>
			{assetEditor.dialog}
			{assetEditor.error && (
				<p role="alert" className="text-sm text-kumo-danger">
					{assetEditor.error}
				</p>
			)}
			{required && !displayUrl && (
				<p className="-mt-1 text-sm text-kumo-danger">{t`This field is required`}</p>
			)}
		</div>
	);
}
