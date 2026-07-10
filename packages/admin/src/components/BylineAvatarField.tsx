/**
 * Avatar picker for the byline editor (#1250).
 *
 * Bylines store only an `avatarMediaId` (the media item's id), not a
 * URL or embedded media object. This component resolves that id back
 * into a full media item so it can hand a populated value to the
 * shared {@link ImageFieldRenderer} — reusing its picker, preview, and
 * broken-image handling rather than duplicating the markup.
 *
 * On change it strips the resolved media back down to the bare id for
 * the byline update body.
 */

import { Label, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";

import { fetchMediaItem } from "../lib/api";
import { ImageFieldRenderer, type ImageFieldValue } from "./ImageFieldRenderer";

export interface BylineAvatarFieldProps {
	/** The byline's stored `avatarMediaId`, or null when unset. */
	value: string | null;
	/** Receives the selected media id, or null when the avatar is removed. */
	onChange: (mediaId: string | null) => void;
}

export function BylineAvatarField({ value, onChange }: BylineAvatarFieldProps) {
	const { t } = useLingui();

	// Resolve the stored id into a media item for display. Local media is
	// served from a storageKey-keyed URL (not the id), so we can't build a
	// usable preview URL until this lands.
	const { data: media, isLoading } = useQuery({
		queryKey: ["media", value],
		queryFn: () => (value ? fetchMediaItem(value) : Promise.resolve(null)),
		enabled: !!value,
	});

	// Show a placeholder while resolving an existing avatar so the wrong
	// (id-keyed) local URL isn't requested and flashed as a broken image
	// before the fetch lands.
	if (value && isLoading) {
		return (
			<div>
				<Label>{t`Avatar`}</Label>
				<div className="mt-2 flex h-32 items-center justify-center rounded-lg border">
					<Loader />
				</div>
			</div>
		);
	}

	const fieldValue: ImageFieldValue | undefined =
		value && media
			? {
					id: media.id,
					provider: media.provider || "local",
					// External providers supply a direct URL; local media derives
					// its URL from meta.storageKey inside ImageFieldRenderer.
					previewUrl: media.provider && media.provider !== "local" ? media.url : undefined,
					alt: media.alt ?? "",
					width: media.width,
					height: media.height,
					meta: media.storageKey ? { storageKey: media.storageKey } : undefined,
				}
			: undefined;

	return (
		<ImageFieldRenderer
			label={t`Avatar`}
			value={fieldValue}
			onChange={(next) => onChange(next?.id ?? null)}
		/>
	);
}
