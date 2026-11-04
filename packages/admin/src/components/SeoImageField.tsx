/**
 * SEO OG Image field for the content editor.
 *
 * Renders an image picker (reusing MediaPickerModal) that stores the
 * selected image URL in `seo.image`. The preview shows the 1.91:1 crop
 * social sites apply to link-preview images.
 */

import { Banner, Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ImageBroken, ImageSquare, Trash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchMediaItem, type ContentSeo, type ContentSeoInput, type MediaItem } from "../lib/api";
import { ApiResponseError } from "../lib/api/client.js";
import { localMediaFileUrl } from "../lib/media-utils.js";
import { cn } from "../lib/utils.js";
import { FieldHelpLabel } from "./FieldHelpLabel.js";
import { ImageDropTarget } from "./media/ImageDropTarget.js";
import { MediaPickerModal } from "./MediaPickerModal";

export interface SeoImageFieldProps {
	seo?: ContentSeo;
	onChange: (seo: ContentSeoInput) => void;
}

const MEDIA_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const URL_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;

// On touch screens the ::after makes each tap target taller than the
// button, so the toolbar doesn't have to grow over the image.
const toolbarButtonClassName =
	"relative rounded-none text-[13px] focus-visible:z-10 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2";

function seoImageUrl(item: MediaItem): string {
	const isLocalProvider = !item.provider || item.provider === "local";
	return isLocalProvider ? `/_emdash/api/media/file/${item.storageKey || item.id}` : item.url;
}

export function SeoImageField({ seo, onChange }: SeoImageFieldProps) {
	const { t } = useLingui();
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [pickerReplaces, setPickerReplaces] = React.useState(false);
	const [loadedUrl, setLoadedUrl] = React.useState<string | null>(null);
	const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
	const fieldRef = React.useRef<HTMLDivElement>(null);
	const dropTargetRef = React.useRef<HTMLDivElement>(null);
	const replaceButtonRef = React.useRef<HTMLButtonElement>(null);
	const pickerOpenedWithFocusRef = React.useRef(false);
	const focusHandoffRef = React.useRef<{ image: string | null; viaPicker: boolean } | null>(null);
	const imageRef = seo?.image || null;
	const mediaId = imageRef && MEDIA_ID_RE.test(imageRef) ? imageRef : null;
	const mediaQuery = useQuery({
		queryKey: ["media", mediaId],
		queryFn: ({ signal }) => fetchMediaItem(mediaId!, { signal }),
		enabled: !!mediaId,
		retry: false,
	});
	const media = mediaQuery.data;
	const isStorageKey =
		mediaQuery.error instanceof ApiResponseError && mediaQuery.error.status === 404;
	const imageUrl = mediaId
		? media
			? localMediaFileUrl(media.storageKey)
			: isStorageKey
				? localMediaFileUrl(mediaId)
				: null
		: imageRef && !imageRef.startsWith("/") && !URL_SCHEME_RE.test(imageRef)
			? localMediaFileUrl(imageRef)
			: imageRef;
	const hasImage = imageRef !== null;
	const failed =
		hasImage &&
		((!!imageUrl && failedUrl === imageUrl) ||
			(!!mediaId &&
				((mediaQuery.isError && !isStorageKey) ||
					media?.status === "pending" ||
					media?.status === "failed")));
	const needsSharingUrl =
		!!mediaId &&
		!!media &&
		media.storageKey !== mediaId &&
		media.status !== "pending" &&
		media.status !== "failed" &&
		!failed &&
		loadedUrl === imageUrl;
	const label = t`OG Image`;

	// Safari and Firefox on macOS don't focus a clicked button. Handing focus to
	// a button the user never focused would let their next Space press open the
	// picker, so the hand-off below only runs when focus was in the field.
	const focusIsInField = () => fieldRef.current?.contains(document.activeElement) ?? false;

	// Swapping between the preview and the drop target unmounts the control
	// that had focus, so once the requested change arrives, hand focus to its
	// counterpart. A picker that is still closing holds focus at that point and
	// would return it to the unmounted control.
	React.useLayoutEffect(() => {
		const handoff = focusHandoffRef.current;
		if (!handoff) return;
		focusHandoffRef.current = null;
		if (handoff.image !== imageUrl) return;
		const active = document.activeElement;
		const focusLost = !active || active === document.body;
		const pickerClosing = handoff.viaPicker && !!active?.closest('[role="dialog"][data-closed]');
		if (!focusLost && !pickerClosing) return;
		const counterpart = hasImage
			? replaceButtonRef.current
			: dropTargetRef.current?.querySelector("button");
		counterpart?.focus({ preventScroll: true });
	}, [hasImage, imageRef, imageUrl]);

	const openPicker = () => {
		pickerOpenedWithFocusRef.current = focusIsInField();
		setPickerReplaces(hasImage);
		setPickerOpen(true);
	};

	const handlePickerSelect = (item: MediaItem) => {
		const url = seoImageUrl(item);
		if (!hasImage && pickerOpenedWithFocusRef.current) {
			focusHandoffRef.current = { image: url, viaPicker: true };
		}
		onChange({ image: url });
	};

	const handleRemove = () => {
		if (focusIsInField()) focusHandoffRef.current = { image: null, viaPicker: false };
		onChange({ image: null });
	};

	return (
		<div ref={fieldRef}>
			<FieldHelpLabel
				help={t`Image shown when this page is shared on social media`}
				helpLabel={t`Why is this important for social sharing?`}
			>
				{label}
			</FieldHelpLabel>
			{hasImage ? (
				<div className="group/og-image relative mt-2 aspect-[1200/630] w-full overflow-hidden rounded-xl bg-kumo-tint">
					{failed ? (
						<div className="flex h-full flex-col items-center justify-center gap-1.5 text-kumo-subtle">
							<ImageBroken className="size-6" aria-hidden="true" />
							<span className="text-xs leading-4">{t`Image not found`}</span>
						</div>
					) : !imageUrl ? (
						<div className="flex h-full items-center justify-center">
							<Loader />
						</div>
					) : (
						<img
							src={imageUrl}
							alt=""
							className={cn(
								"size-full object-cover",
								// Until it loads, a checkerboard would read as a transparent image.
								loadedUrl === imageUrl && "emdash-media-transparency-grid",
							)}
							onLoad={() => setLoadedUrl(imageUrl)}
							onError={() => setFailedUrl(imageUrl)}
						/>
					)}
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-kumo-line ring-inset"
					/>
					<div
						role="group"
						aria-label={t`Image actions`}
						className={cn(
							"absolute end-1 top-1 flex items-stretch rounded-lg border border-kumo-line bg-kumo-control shadow-xs",
							// Opacity, not visibility, keeps the buttons in the tab order. Without
							// pointer events, a tap can't hit a button before it shows.
							!failed && [
								"pointer-events-none opacity-0 motion-safe:transition-opacity motion-safe:duration-150",
								"group-hover/og-image:pointer-events-auto group-hover/og-image:opacity-100",
								"group-has-focus-visible/og-image:pointer-events-auto group-has-focus-visible/og-image:opacity-100",
								"pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
							],
						)}
					>
						<Button
							ref={replaceButtonRef}
							type="button"
							size="sm"
							variant="ghost"
							className={cn(toolbarButtonClassName, "gap-1.5 rounded-s-[7px] px-2.5")}
							icon={<ImageSquare className="size-3.5" aria-hidden="true" />}
							aria-label={t`Replace ${label}`}
							onClick={openPicker}
						>
							{t`Replace`}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							shape="square"
							className={cn(
								toolbarButtonClassName,
								"rounded-e-[7px] border-s border-kumo-line hover:text-kumo-danger pointer-coarse:w-8",
							)}
							icon={<Trash className="size-3.5" aria-hidden="true" />}
							aria-label={t`Remove ${label}`}
							title={t`Remove ${label}`}
							onClick={handleRemove}
						/>
					</div>
				</div>
			) : (
				<div ref={dropTargetRef} className="mt-2">
					<ImageDropTarget
						label={label}
						onSelect={openPicker}
						onUploaded={(item) => onChange({ image: seoImageUrl(item) })}
					/>
				</div>
			)}
			{needsSharingUrl && imageUrl && (
				<Banner
					className="mt-2"
					variant="alert"
					role="note"
					title={t`Sharing image needs a URL`}
					description={
						<div className="flex flex-col items-start gap-2">
							<p>{t`The saved media ID may not work in shared links. Save the image URL to use this file for sharing.`}</p>
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() => {
									if (focusIsInField()) {
										focusHandoffRef.current = { image: imageUrl, viaPicker: false };
									}
									onChange({ image: imageUrl });
								}}
							>
								{t`Save image URL`}
							</Button>
						</div>
					}
				/>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handlePickerSelect}
				mimeTypeFilter="image/"
				title={pickerReplaces ? t`Replace ${label}` : t`Select ${label}`}
				confirmLabel={pickerReplaces ? t`Replace` : undefined}
			/>
		</div>
	);
}
