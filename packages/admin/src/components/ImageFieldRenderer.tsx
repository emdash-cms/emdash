/**
 * Image field with media picker
 *
 * Stores full image metadata including dimensions for responsive images.
 * Handles backwards compatibility with legacy string URLs.
 *
 * Extracted from ContentEditor so non-top-level field UIs (e.g. repeater
 * sub-fields) can reuse the same picker without a circular import.
 */

import { Button, Label } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Image as ImageIcon, ImageBroken, X } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../lib/api";
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
	alt?: string;
	width?: number;
	height?: number;
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
			meta: isLocalProvider ? { ...item.meta, storageKey: item.storageKey } : item.meta,
		});
	};

	const handleRemove = () => {
		onChange(null);
	};

	return (
		<div id={id}>
			<Label>{label}</Label>
			{displayUrl ? (
				imageBroken ? (
					<div className="mt-2 relative group">
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
					<div className="mt-2 relative group">
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
					className="mt-2 w-full h-32 border-dashed"
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
			{description && <p className="text-xs text-kumo-subtle mt-1">{description}</p>}
			{required && !displayUrl && (
				<p className="text-sm text-kumo-danger mt-1">{t`This field is required`}</p>
			)}
		</div>
	);
}
